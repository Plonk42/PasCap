# Development

The current strict schema requires twelve graded scalar bases in each video track's `colour`,
including Temperature (−2…2), Tint, Whites and Blacks (−1…1), Vibrance (−1…2), all neutral 0, plus `hdr` (0–1, neutral 0; a
detail-stage look applied before grading, see [detail filters](design/DETAIL_FILTERS.md#hdr-look))
and `localContrast` (−1…1, neutral 0; the local-detail boost split out of HDR, see
[local contrast](design/DETAIL_FILTERS.md#local-contrast)),
all eight HSL bands and all four
colour curves. Shared keyframes require fifteen nullable fields, each enabled one with its own Easing, and a
boolean `reset` (default keyframe), in control order:
`opacity`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`,
`hue`, `saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`. HSL/curves remain static; speed is
clip-only (constant or 1–256 source-frame keyframes), and every clip requires a boolean `reverse`.
Projects saved with an older supported schema are upgraded on load through
[project migrations](../src/shared/project-migrations.ts); documents and receipt
snapshots older than `OLDEST_PROJECT_SCHEMA_VERSION` are rejected and preserved, with no
load defaults or automatic deletion. CPU/reference/native/GPU
must use the same [Temperature/Tint gain math](design/TEMPERATURE_AND_TINT.md)
before Exposure, including intentionally coloured greys and pre-clipping
neutral-white linear luminance normalization only. Required synthetic validation
retains neutral identity, axis signs/combined grades, grayscale/HSL boundaries,
GPU uniform capacity, exact native sharp knees and unchanged pixel/frame/resource
gates; this update claims no new test results. Nonneutral HSL/curves use exact
complete CPU grading through composited export; neutral advanced settings retain
scalar LUT paths. At most two native 65³ Float32 buffers (6,591,000 bytes) remain
available, without an extra decoder, texture, full-frame buffer or child process.
Exact advanced grading remains the costliest export path, especially at UHD. See
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md). New reference/measurement metadata
identifies the current schema; historical reports remain unchanged.
The current schema number is `PROJECT_SCHEMA_VERSION` in [the model](../src/shared/model.ts);
bump it for every incompatible change. Guides say “current schema” rather than repeating the number.

Local Linux setup and contributing. Editing: [USER_GUIDE.md](USER_GUIDE.md). Service
paths and **future, not implemented** containers: [DEPLOYMENT.md](DEPLOYMENT.md).

## Requirements

- **Linux**, npm, **Node 22 LTS ≥22.12.0 or 24 LTS** (`>=22.12.0 <25`). Validation
  targets 22/24, not every intervening major version.
- **FFmpeg/ffprobe 8.0.1**, the tested baseline; FFmpeg 6 is unqualified.
  Other builds need parity tests. Require `libx264`, FFV1, AAC, `lut3d`/`xfade`, raw
  RGB/lossless RGBA16 and the existing timing/colour filters and bitstream tools.
- Browser **WebCodecs** `VideoDecoder` with H.264, module workers, **WebGL2** and
  **AudioWorklet**/`getOutputTimestamp` for music; tests use installed **Google Chrome**
  (`channel: 'chrome'`), not bundled Chromium: [configuration](../playwright.config.ts).

## Run locally

Run from the repository root; version output alone does not prove native parity.

```sh
node --version && npm --version
ffmpeg -version && ffprobe -version
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**; the media API binds only to **127.0.0.1:4318**.
For the built UI/API together, stop development first:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4318**. Never run two service processes against the same
data directory: revision protection coordinates tabs within one service only.
This is not static hosting, LAN/SaaS deployment or a completed container recipe.

## Configuration and storage

| Variable                            | Meaning                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASCAP_DATA_DIR`                   | Generated-data directory; defaults to the ignored `.pascap/`                                                                                                                                                                                                              |
| `PASCAP_MEDIA_ROOTS`                | JSON array of up to 32 unique absolute roots shared by footage/music browsing; defaults to the service user's Videos folder; `[]` disables both browsers, not deliberate manual path imports                                                                              |
| `PASCAP_PORT`                       | Unprivileged loopback service port, default 4318                                                                                                                                                                                                                          |
| `PASCAP_FFMPEG` / `PASCAP_FFPROBE`  | Native executable paths, otherwise resolved from PATH                                                                                                                                                                                                                     |
| `PASCAP_MEASURE_URL`                | Editor URL/project used by the optional measurement helper                                                                                                                                                                                                                |
| `PASCAP_CHROME`                     | Browser for the export GPU compositor, otherwise `google-chrome` or `chromium` from PATH                                                                                                                                                                                  |
| `PASCAP_GPU_COMPOSITING`            | `auto` (default) composites detail/HDR export groups on a hardware GPU when one starts; `off` always uses the CPU compositor                                                                                                                                              |
| `PASCAP_HW_DECODE`                  | `auto` (default) decodes undamaged originals for proxy encodes with NVDEC when a CUDA device starts; `off` always uses the CPU decoder                                                                                                                                    |
| `PASCAP_ASSISTANT_STILL_WIDTH`      | Largest still width and crop side the picture operations render, 160–1280, default 480 ([stills](design/ASSISTANT_MCP.md#stills-and-contact-sheets))                                                                                                                      |
| `PASCAP_ASSISTANT_SHEET_CELL_WIDTH` | Width of each contact-sheet cell, 96–640, default 240                                                                                                                                                                                                                     |
| `PASCAP_ASSISTANT_SHEET_CELLS`      | Frames per contact sheet, 1–24, default 9                                                                                                                                                                                                                                 |
| `PASCAP_ASSISTANT_LEASE_MINUTES`    | An assistant session ends after this many minutes without a call on its project, 0–1440; default 0 never ends it, leaving it to the user's **Take over** or the assistant ([sessions](design/ASSISTANT_MCP.md#assistant-session-and-checkpoint-service-files-not-schema)) |
| `PASCAP_ASSISTANT_CHECKPOINTS`      | Checkpoints kept per project, oldest removed first, 1–50, default 5                                                                                                                                                                                                       |

For example, start with an explicit approved root (literal `~` is not expanded):

```sh
PASCAP_MEDIA_ROOTS='["/home/you/Videos","/mnt/footage"]' npm run dev
```

Generated data is not an original-footage backup; keep it outside footage. It holds
registries (`videos.json`, `music.json`, version 2), proxies/thumbnails, Import dialog previews, projects, exports/receipts, measurements and scratch.
Original paths remain identity-checked even with ready proxies; relinking is explicit
and byte-verified ([relinking](design/SOURCE_RELINK.md)), with no implicit relink or
migration. Preserve registered bytes/paths, including previously copied sources.
The browsing/registration API table and mount/security contract live in
[DEPLOYMENT.md](DEPLOYMENT.md#no-copy-source-access-today), not a second API table here.

## Validation

```sh
npm run check
npm run test:media
npx playwright install --with-deps chrome
npm run test:browser
```

- `npm run format` applies Prettier ([configuration](../.prettierrc.json)) to the
  repository; `check` first verifies that formatting with `format:check`.
  [Workspace editor settings](../.vscode/settings.json) use the same Prettier
  formatter and disable inherited **Organize Imports on save**: Prettier does not
  sort imports, so a second save-time organizer would create changes after the
  command-line gate and commit. Manual **Organize Imports** remains available;
  apply deliberate import cleanup before validation and commit.
- `check` runs strict frontend typechecking, unit/service tests and the production
  build/server typecheck and locked production-license inventory. Builds retain the
  upstream notice texts in a served notice artifact; `npm run licenses:check`
  verifies the inventory without building/writing. See [licensing](LICENSING.md).
  `npm test` runs Vitest; native tests require `test:media`.
- Check **SonarQube for IDE** diagnostics on affected code files while editing and
  before delivery. Fix relevant new quality/security findings rather than adding
  `NOSONAR`, suppressing warnings or excluding files; report justified exceptions
  or unavailable analysis. It is not part of `npm run check` or CI, and docs-only
  changes do not need it.
- `test:media` uses disposable temporary **synthetic** sources/projects/outputs only.
- `test:browser` builds/creates synthetic fixtures, then runs serial Chrome workflows
  on its own service at **4320**, without reusing a running service.
- `npm run test:space` is an additional explicit Linux native check using `unshare`,
  `mount` and `umount` with unprivileged user namespaces. It exhausts a private
  32 MiB tmpfs, never a shared disk or host mount, and needs no sudo. The ordinary
  native suite does not enable this platform-specific test implicitly. Run both
  native suites together with `PASCAP_MEDIA_TESTS=1 PASCAP_SPACE_TESTS=1 npm test -- tests/media`.
  Hosts forbidding user namespaces must not claim that acceptance from unit mocks.

### Firefox music regression and optional investigation

Chrome remains the full browser validation target. The
[Firefox configuration](../playwright.firefox.config.ts) runs the same isolated
synthetic service/fixtures with Playwright's Firefox, not an existing desktop
Firefox profile. Install it with `npx playwright install --with-deps firefox`.
GPU-less Linux also needs Xvfb/xauth, Mesa EGL/GLX/DRI and a real audio output service:
packages `xvfb`, `xauth`, `libgl1-mesa-dri`, `libegl-mesa0`, `libglx-mesa0`,
`pulseaudio` and `pulseaudio-utils`. After the ordinary build and clean browser
fixture setup, reproduce the isolated CI graphics/audio environment with:

```sh
LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe \
__GLX_VENDOR_LIBRARY_NAME=mesa \
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
bash scripts/ci/firefox.sh npx playwright test --config=playwright.firefox.config.ts \
  tests/browser/music-clock.spec.ts tests/browser/playback-recovery.spec.ts \
  --grep 'streaming music clock|streamed PCM|with music normal speed|held sources|decoder that stops delivering|late decoder catches up|with music and a withheld-seek cancellation'
```

Firefox remains headless, but its native graphics probe needs a working display:
without one, Firefox can reject WebGL2 with `AllowWebgl2:false` before compositor
startup. Xvfb supplies that display and Mesa llvmpipe supplies real software GL;
no WebGL force-enable/blocklist bypass, capability override or mock is used.
The Firefox-only [prerequisite check](../scripts/ci/firefox-webgl.ts) fails before
media tests when real WebGL2 context creation, production compositor shader
compilation/linking or exact one-pixel clear/readback is unavailable. Browser launch
has a 15-second deadline; page creation/graphics probing has a separate 10-second
deadline. Failure reports the native context reason and setup guidance rather than
waiting through repeated preview-readiness timeouts. Success logs the browser version,
actual renderer, shader status and readback; renderer sanitization is disabled only
in the disposable test profile for this evidence, not in the product. The playback
tests still initialize the real editor/compositor and keep their existing exact
frame, PCM, drift, range-read and cancellation assertions.

The [grade-comparison music regression](../tests/browser/grade-comparison.spec.ts)
retains each trusted native pointer/Space/Enter activation and its subsequent real
Playing draw at observation time. Slow browser-protocol assertions may observe
legitimate completion later; they do not replace that retained checkpoint with a
later diagnostics read. All four activations must happen while Playing, render
their requested mode before the end, and retain one music epoch, exact source
readiness and the independent one-frame output-clock bound through full completion.
The memory-only fixture is one 0.1× clip, 1,200 project frames (40 s): hosted
software rendering needed about 17 s for the four activations, which no longer
fit in the former 16 s window ([#126](https://github.com/Plonk42/PasCap/issues/126)).
No clock forgery or throughput threshold is used.

On a rejected graphics result, the prerequisite also runs the installed Firefox
bundle's native `gfxtest glx` once in the same display/Mesa environment, with a
five-second deadline and 32 KiB limit per output stream. It logs and retains the
browser/context result, selected graphics environment and native EGL/GLX output
in the failure artifacts. A successful native GLX probe cannot qualify a rejected
browser WebGL2 context; there is no context retry, force-enable or fallback.
The privileged `about:support` page is not navigable through this Firefox build's
Playwright/Juggler integration, so it is not used as a potentially hanging diagnostic.

Firefox gives its own startup GLX probe four seconds (`GFX_TEST_TIMEOUT`); if that
probe is late or fails, Firefox blocks WebGL2 for the whole session
(`AllowWebgl2:false`). Hosted runs showed this intermittently while the native
probe immediately afterwards succeeded. A cold first load of Mesa/LLVM is the
suspected cause but is **not confirmed**: the first hosted warm-up took 195 ms,
and a local forced probe failure printed no reason on Firefox's stderr. The prerequisite
runs the same bundled `gfxtest glx` once **before** launching Firefox and logs
its duration. This only loads libraries: Firefox still runs its own probe and
must create the real WebGL2 context; the warm-up result is evidence, never a
gate, retry or capability override. If the failure recurs, compare the logged
warm-up duration with the failure evidence before changing anything else.

Headless Firefox also needs an available audio backend: a missing service can leave
`AudioContext.resume()` suspended without rendering samples. The
[Firefox runner](../scripts/ci/firefox.sh) starts a private PulseAudio server with a
48 kHz stereo null sink, cookie and Unix socket in an owned temporary directory.
It never changes the desktop server/default output or accesses sound devices;
the null sink discards audio **after real Web Audio rendering**, not through a
mock clock or silent product fallback. Startup and backend queries have bounded
deadlines, and exit/failure/signals stop only that server and remove its scratch.
The subsequent [audio prerequisite](../scripts/ci/firefox-audio.ts) has the same
15-second browser-launch and 10-second probe deadlines as the graphics check.
It requires a real 48 kHz context, stereo samples passed between real worklets and
an output timestamp reaching those rendered samples. Missing resume/render/output
readiness remains an actionable hard failure before the media tests. Neither
prerequisite changes the editor's ten-second music-start deadline or test bounds.

The [music-clock regression](../tests/browser/music-clock.spec.ts) requires one
uninterrupted music start from zero or a nonzero seek, bounded range reads and
actual rendered stereo PCM amplitude/placement silence. Its bounded audio-thread
observer checks every sample in the required frame windows, not UI-thread snapshots
that can miss complete frames under load. The selected
[recovery tests](../tests/browser/playback-recovery.spec.ts) retain the
independent one-frame audio/video bound and exact decoded source identities for
normal-speed and 0.1× held-source playback with and without music. A
[frame gate](../tests/browser/video-frame-gate.ts) holds or fails real decoded
frames on their way from the video reader worker: a decoder that stops delivering
holds the image, buffers and fails after five seconds with an explicit message;
a late decoder under music keeps the music clock and catches up by dropping
passed frames, without restarting music; pause/seek/restart and a withheld paused
seek are cancelled without stale images. These synthetic, memory-only browser
checks run in CI; they do not qualify the entire Firefox editor or intended
hardware. Attachments contain bounded consumed-sample/output-timestamp evidence
and at most 500 decoder/clock state snapshots around music transitions, not
private media. Recovery failures also retain at most ten independent A/V
violation witnesses: the offending state, raw receipt/output timestamps and
observation interval. These diagnostics never change the frame comparison,
tolerance or result. The decoding contract is in
[WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md).

### Fast local validation

The commands above are complete entry points, not a chain to run after every edit.
Full Chrome, Firefox and native suites run in CI; run them locally only when
changing playback, decoding, native export or test infrastructure. UI changes still
need the [live inspection](#live-ui-inspection) below.

- While editing: `npm test -- tests/unit/<file>.test.ts` (or `npm run test:watch`)
  and the dev server.
- Before pushing: `npm run format`, then `npm run check`, plus the affected browser
  specs for UI changes. `check` has just built `dist/`, which Playwright serves:

  ```sh
  npx tsx scripts/fixtures.ts --browser
  npx playwright test tests/browser/<spec>.spec.ts
  ```

  Install Chrome once with `npx playwright install --with-deps chrome`.

- Choose affected specs by search, not memory: after `git pull`, search
  `tests/browser` for every accessible name, selector and visible/help text the
  change renames, removes or newly hides (for example behind a toggle), and run
  every matching spec, not only the ones you edited.

- Reuse fixtures across focused runs while tests leave their baseline intact;
  reseed after state-changing runs. Never build or reset fixtures while a browser
  run serves that output.
- Docs-only changes need only `npm run format`. Never shorten timeouts, add retries
  or weaken assertions for speed.

### CI-only failures and time limits

Hosted runners have four shared vCPUs, no GPU (software WebGL) and variable speed.
A failure seen only there usually means too little real-time or time-limit
headroom, not an unreliable test. Treat it as a product or test-budget defect:

1. `GH_TOKEN="$(gh auth token)" npm run ci:failures -- 30` groups failing tests
   and Firefox prerequisites across the last 30 failed CI runs. A signature seen
   twice is a bug: open an issue and fix it before more feature work.
2. Reproduce first with `npm run test:browser:ci-like -- tests/browser/<spec>.spec.ts`:
   the [CI-like configuration](../playwright.ci-like.config.ts) forces software
   WebGL without a GPU process and pins the run to two cores
   (`PASCAP_CI_LIKE_CPUS`, default `0-1`). Run it before pushing playback,
   compositor or music changes too. It is a diagnostic, not a qualification.
3. Fix the cause. Never add retries, skips or weaker assertions, and never turn
   runner speed into a correctness or performance gate.

Every Vitest and Playwright run reports, through the
[timing reporters](../tests/timing/budget.ts), tests that used at least a third
of their time limit, in the CI job summary and locally when any qualify. Size a
heavy test's limit at roughly three times its measured time locally or CI-like;
raising a limit for legitimately heavy work is fine. Tests installing music
evidence add an informational `realtime-headroom` annotation: music starts and
underruns, the lowest queued music at audio-thread receipts and, in Chrome, the
longest main-thread task. These readings are never asserted.

The [real-time stress workflow](../.github/workflows/realtime-stress.yml) repeats
the Chrome music/playback regressions five times nightly and on manual dispatch
(1–20 repeats). It is not a required check; a failure there is an early warning
to triage like any CI-only failure.

**Browser fixture setup resets `.pascap/browser-tests/`**; never store personal work
there. It seeds twelve video memberships, music and proxies. Separate import-test
originals in `.pascap/browser-footage/synthetic-sources/` are outside that cache;
`browse-camera-*` means generated patterns, not real recordings. The
[fixture factory](../scripts/fixtures.ts) uses `preview-lab-v6` outside the browser
cache and `preview-lab` inside it. These are project identifiers, not schema
versions; newly generated documents must satisfy the strict current schema, including complete video track
colour with Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local contrast, all fifteen nullable channels and track Transform
base/per-setting keyframes. Bin resets never imply
a global-library fallback.
Neither suite invokes real-source sample preparation or needs private footage/music.

The [music-browser regression](../tests/browser/music-browser.spec.ts) uses memory-only
projects and the existing prepared synthetic WAV. It copies that generated test WAV
into one temporary subfolder of the isolated approved browser root (the fixture's
original path is inside the excluded cache), then removes only that owned subfolder.
Normal navigation/confirmation exercise the guarded audio routes; unavailable locations,
access/probe/write failures and stale reads use disposable route responses. No fixture
generator/reset, private audio, music placement or export is needed.

### Live UI inspection

**Required for UI/layout/control/interaction changes**, alongside the affected
automated specs, not a full browser-suite run:

1. Open or reuse a tab in the **VS Code integrated browser** before changing the
   UI, and inspect it again after the final edit. Use a memory-only project or the
   isolated synthetic browser-test service, never saved projects or real media.
2. Use **Playwright browser controls** to exercise the changed workflow, including
   relevant normal, error/disabled, expanded, popover, pointer and keyboard states.
3. Capture and inspect **rendered screenshots** for alignment, spacing, clipping,
   readable values, reachable controls and scrolling at the **1440 × 900** default
   and the **1280 × 720** minimum supported viewport. When panels are affected,
   also check their minimum sizes at 1280 × 720: Media 240 px, Properties 270 px,
   Timeline 200 px. Size the viewport explicitly; a docked browser panel is often
   smaller. Smaller windows are best effort and need no live inspection
   ([supported sizes](WORKSPACE_AND_RECOVERY.md#layout-and-navigation)).
   DOM snapshots and passing tests do not establish visual correctness.
4. Fix issues and repeat the live checks after the last edit. Run the focused
   specs separately. Never build or reset fixtures while a tab or test run serves
   the same output/cache.
5. Summarise the states and viewports actually checked and any gaps. If browser
   access is unavailable, report that blocker instead of claiming visual validation.

### GitHub CI

The [workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`
and manual dispatch ([job overview](GITHUB_WORKFLOW.md#ci-and-branch-protection)):

- Unit/type/build checks on **Node 22**, plus **Node 24** and `npm audit` on `main`.
- Native media, four Chrome shards and the scoped Firefox music checks run in
  parallel on Node 22 with **FFmpeg/ffprobe 8.0.1 built from pinned source** through
  a shared [setup action](../.github/actions/setup-ffmpeg/action.yml) and cached
  toolchain, not runner apt FFmpeg 6. Firefox alone runs under Xvfb with Mesa
  llvmpipe and a fail-closed real WebGL2 prerequisite; its software-rendering
  environment is not applied to Chrome or native jobs.
- Each browser job builds and seeds its own isolated synthetic fixtures. Read-only
  repository permissions, dependency/toolchain caching and failure-only retained
  Playwright traces/screenshots.
- The unconditional **Delivery gate** is the only required check; it fails unless
  every job above returned `success`.
- Synthetic fixtures only: no private media/sample helper/native reference work
  or hardware/performance acceptance claim.

The [FFmpeg setup script](../scripts/ci/setup-ffmpeg.sh) verifies the official 8.0.1
source archive SHA-256, enables GPL/libx264 explicitly and checks the required
filters/encoders/bitstream tool. Its installation directory is cached by script
content, runner architecture and Ubuntu release; Node dependencies use the lockfile.
Native/browser jobs retain failure diagnostics for seven days, never original media
or the whole generated cache. Action references are commit-pinned and the workflow
uses read-only repository permissions. It does not deploy GitHub Pages or publish
a container image. Use [the roadmap](ROADMAP.md) for remaining qualification work.

The raw reader has a deterministic exit-before-read regression and eager bounded
read ownership; [#1](https://github.com/Plonk42/PasCap/issues/1) records its delivery
evidence. CI does not retry tests to hide failures. [UX_HARDENING.md](UX_HARDENING.md)
describes ownership, identity limitations, storage assumptions/recovery and loading boundaries.

The three-recording playback completion check has a bounded 45-second wait inside
a 60-second test, with renderer/decoder diagnostics and exact end-frame/error/
two-decoder assertions. This is correctness on software rendering, not the
intended-GPU throughput gate.
Playback recovery checks record requested project frames, presented source frames
and decoder state. Every presented image must be the exact decoded source frame
for its project frame; buffering holds the previous image. Neither a universal
stall count nor a software-renderer FPS threshold qualifies hardware.

## Optional real-media tools

**Do not run these in CI or without the owner's explicit approval for real jobs.**
The [sample helper](../scripts/prepare-samples.ts) targets **DJI_0468.MP4 and DJI_0469.MP4
only**: pass an **explicit folder after `--`**, never rely on a personal-path default.
It reuses ready proxies but may prepare missing ones; creates only an absent current-schema
sample, never overwrites or migrates existing edits.

The [measurement helper](../scripts/measure-preview.ts) accepts exactly **two
forward 1× clips on one enabled, zero-origin contiguous video track with Opacity 1**, no music,
extra tracks, Transform edits/keyframes or shared track keyframes
(even neutral keyframes). `PASCAP_MEASURE_URL` selects that project.
Measurement uses static scalar track Colour (including Temperature/Tint) with Shadows/Highlights/HDR/Local contrast 0, neutral
HSL and identity curves; metadata must identify the strict current-schema snapshot independently of the
report format/identifier; historical reports and receipt snapshots stay untouched.
`npm run measure -- --skip-playback --reference` skips playback benchmarking but
**renders a native reference**; `--headed --reference` adds repeated playback. The edit
is not saved, but reports/output are written. Keep the tab visible and check the
**actual renderer**, not assumed discrete-GPU Chrome. Heap excludes decoder/driver/
total-process memory; reports expose private paths/snapshots, so review before sharing.
[FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md) records historical scope, not GPU qualification.

## Architecture

| Boundary | Entry points                                                                                                                                                     | Responsibility                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Shared   | [Model](../src/shared/model.ts), [commands](../src/shared/commands.ts), [layout](../src/shared/timeline.ts), [clip speed](../src/shared/speed.ts)                | Strict data, integer-frame timing, atomic edits; no React/browser/FFmpeg dependencies         |
| Preview  | [Engine](../src/preview/engine.ts), [video reader](../src/preview/video-source.ts), [compositor](../src/preview/compositor.ts), [music](../src/preview/music.ts) | Exact decoded frames (WebCodecs worker), WebGL2/Web Audio; independent of React               |
| Web      | [App](../src/web/App.tsx), [autosave](../src/web/autosave.ts)                                                                                                    | Panels, contextual controls, transient pointer/input drafts, session history and serial saves |
| Service  | [HTTP app](../src/server/app.ts), [library](../src/server/library.ts), [jobs](../src/server/jobs.ts), [composited export](../src/server/layered-export.ts)       | Guarded registered-source access, bounded native work and verified immutable exports          |

### Service operations

New service capabilities are **operations**, defined once and served as `POST /api/ops/<name>`
behind the usual loopback and client guards; the [MCP endpoint](#mcp-endpoint) exposes the same
definitions ([operation registry](design/ASSISTANT_MCP.md#the-operation-registry)). To add one:

1. Define it in `src/shared/operations/<name>.ts` with `defineOperation`: snake_case name,
   a description written for an LLM, a strict Zod input whose every field has
   `.meta({ description })`, the output schema, `access` and `audience`. Add it to
   `operations` in [the registry](../src/shared/operations/index.ts).
2. Implement its runner in `src/server/operations/<name>.ts` and add it to `runners` in
   [the server registry](../src/server/operations/index.ts); type checking requires one.
3. Run `npm run operations:catalogue` to update the catalogue in the design guide. Unit tests
   fail on duplicate names, missing descriptions, schemas JSON Schema cannot express or a
   stale catalogue.
4. The editor calls it with `callOperation(name, input)` from [the client](../src/web/operations.ts),
   which validates the response.

Existing REST routes move to operations when touched or when an operation needs them. A new
edit command belongs in [`editCommandSchema`](../src/shared/command-schema.ts), with
descriptions; the `edit` operation then accepts it.

### MCP endpoint

The service answers MCP clients at `http://127.0.0.1:4318/mcp` ([MCP server](design/ASSISTANT_MCP.md#mcp-server);
`npm run dev` also proxies it at `http://127.0.0.1:5173/mcp`):
every operation whose audience includes `assistant` is a tool, with its description and input
JSON Schema; stills and sheets come back as image content. The playbook is the resource
`pascap://guide` and the prompt `rough_cut` (in VS Code chat, `/mcp.pascap.rough_cut`).
Requests need the bearer token the
service writes at startup to `<data directory>/mcp-token` (owner-only), and keep the loopback
Host and Origin checks. In VS Code, add to `.vscode/mcp.json` (or the user `mcp.json`):

```json
{
  "inputs": [
    { "id": "pascap-token", "type": "promptString", "description": "Contents of .pascap/mcp-token", "password": true }
  ],
  "servers": {
    "pascap": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer ${input:pascap-token}" }
    }
  }
}
```

The endpoint is the official MCP SDK v2 handler (`@modelcontextprotocol/server`), serving the
2026-07-28 protocol revision and stateless 2025-era clients from [mcp.ts](../src/server/mcp.ts);
the unit tests drive it with the SDK's client in both eras. The assistant edits only inside a
session it starts with `session_start` ([sessions](design/ASSISTANT_MCP.md#assistant-session-and-checkpoint-service-files-not-schema)):
meanwhile the editor follows its edits read-only, with **Take over** and, afterwards, **Restore
project before session** ([hand-off](design/ASSISTANT_MCP.md#hand-off-in-the-editor)). `tsx watch` restarts on source
edits and drops in-flight tool calls, as it ends exports.

Preview decodes editing proxies with WebCodecs in a worker, using **two decoders and
textures per track, up to 16 for eight**, plus one source-review decoder, not one per
clip ([WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md)). Each track can dissolve independently. Generalized
composited export renders premultiplied RGBA16 track groups. Every `VideoLayer`
requires numeric `opacity` in 0–1, initially 1 (100%) on new tracks. Evaluate that
track value or its sole overriding `opacity` keyframe channel for each source, including
both dissolve sources; there is no saved `clip.opacity` or second opacity channel.
With graded RGB $G_i$,
black-fade brightness $b_i$, Opacity $o_i$, dissolve weight $w_i$ and per-pixel
spatial coverage $m_i$, group RGB is $C = \sum_i G_i b_i o_i w_i m_i$ and
coverage is $A = \sum_i o_i w_i m_i$.
Groups merge bottom-to-top as $\mathrm{result} = C + \mathrm{lower}(1 - A)$,
without regrading or another opacity multiplier. Opacity is composition coverage,
not SDR RGB grading; unkeyed colour settings are track-owned. Black fades preserve coverage;
each dissolve remains one group. Serial limits: one original decoder, two intermediate readers,
one encoder and three native video children per pass. Each video decoder, filter
and encoder (proxy preparation, export, verification) uses half the host cores,
bounded to 2–8 threads ([policy](../src/server/native-threads.ts)); lossless FFV1
intermediates use 16 slices above two threads so every encoder thread has work.
Audio and thumbnail work keep two. With `PASCAP_HW_DECODE=auto` and a CUDA device (probed once
per service), the proxy encode decodes undamaged originals with NVDEC (`-hwaccel cuda`): its frames,
and so the proxy, are identical to the CPU decoder's, and it frees about half the encode's CPU
(a 30 s UHD proxy encode took about 7.4 s instead of 10.6 s on the development machine). Damaged originals keep
the CPU decoder their repair was verified with. A failed NVDEC encode is retried once on the CPU,
which the service then keeps using, and the job says so. While the proxy encodes, one more two-thread decoder
seeks the original's three comparison frames (beginning, middle and end), one at a time,
independently of the encode; it stops if the encode fails or is cancelled, and the frames are compared
with the proxy only after its own frame-count checks. Camera motion analysis, a background job that runs
after every other queued job, decodes the proxy with two threads and measures 30-frame
chunks on at most eight worker threads (host cores − 1), about 2 MB of frames each. Four raw buffers (two RGB8,
two RGBA16) use **22 bytes/pixel = 182,476,800 bytes at UHD**; two 65³ Float32 LUTs
add **6,591,000 bytes**, excluding native/audio memory. CPU composition/LUT bands
run on at most eight worker threads sharing those buffers, without copies. Two retained clip files and
three timeline representations bound concurrency, **not disk GB**;
scratch grows with duration ([resource contract](LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits)).
The static fast path requires one enabled, unanimated, zero-origin contiguous
video track with Opacity 1 and Shadows/Highlights/HDR/Local contrast 0, neutral HSL/identity colour curves, an exactly neutral track Transform base without Transform keyframes
and neutral clip Sharpen/Clarity/Denoise;
any Transform edit/keyframe (even neutral keyframes), [detail filter](design/DETAIL_FILTERS.md) or unsupported placement/coverage uses
generalized composited export, regardless
of Ripple or track ID.
Processing: [track keyframes](LAYERS_AND_KEYFRAMES.md), [retiming/audio](SPEED_AND_AUDIO.md)
and [grading equations](COLOUR_AND_TIMING.md#colour).

Each video track requires `transform: { base, keyframes }`: eight
complete pose values and 0–256 per-setting project-frame keyframes with required
easing and `reset` (default keyframe); clips have no `spatial` field. Shared
[spatial mapping](../src/shared/spatial.ts) uses unrounded original-aspect contain
fit, original-centre pivot and half-open crop bounds; crop does not refit.
The pose evaluates at absolute project time, like Colour, and applies to every
source on the track, each with its own coverage; `sourceAt` supplies recorded-image
identity, so geometry can move on held images without optical flow. Exact neutral
poses preserve old opaque black letterboxing after grading; nonneutral uncovered
pixels have zero coverage. Native inverse RGB resampling precedes grading, reusing
the same four raw buffers/two LUTs and serial process limits, without an extra
resampling pass. Trim/cut/split/duplicate/move never copy or shift Transform; a
moved clip adopts its destination track's Transform. **Track → Transform** is
collapsed by default and uses explicit per-setting project-frame capture,
stored-keyframe navigation and live-preview sliders. See
[the Transform contract](design/SPATIAL_TRANSFORMS.md), not historical benchmark
reports, for current geometry/schema/UI facts.

Up to eight independently identified music tracks, each holding up to eight clips joined by
transitions, share one bounded mixed queue, AudioContext/worklet and output clock. Apply
each clip's track gain and fades, sum linearly,
then clamp once after the full mix. Native audio stays serial: one original decoder,
at most two intermediate inputs and three scratch files (selected PCM plus old/new
Float64 accumulators). Audio storage planning is maximum selected PCM plus two full
project accumulators. Project duration includes every music OUT; absent active video
is opaque black, not a held last image, while music continues/fades at its own OUT.
Video closing fades remain inside their last clips. The static export path must
cover the full project; music tails use composited export. Export still requires a video clip.
See [the multiple-music contract](design/MULTIPLE_MUSIC.md).

The single **Opacity** slider/exact field belongs in **Track → Colour** alongside
the colour sliders and works on an empty track. Its diamond is always visible, with adjacent per-setting Previous/Next buttons; stored enabled-setting
chip arrows remain available too. Main and stored sliders/
exact fields use **0–100%**, neutral **100%**; convert only at the UI boundary,
keeping required `VideoLayer.opacity` and `opacity` keyframes **0–1** with no schema change.
Without Opacity keyframes, it edits track `opacity`; with keyframes, only an enabled setting at the
real playhead permits editing, with the diamond explicitly capturing a missing
setting. Sliders never create keyframes. **Placement** contains placement only;
Track options contains rename, Ripple, ordering and deletion, with visibility separate.

Colour, Speed and Transform always show their capture diamonds while the section is expanded, Colour and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown. The per-setting buttons remain alongside the stored enabled-setting chip arrows because not every setting is enabled at every shared keyframe.
Each keyframe line has one Previous/Next pair: Colour visits the union of
Opacity, twelve scalar, HDR and Local contrast keyframes; Speed visits all retained custom speed source
keyframes of the selected clip, including off-trim keyframes and original exclusive
OUT, previewing the nearest mapped image through authoritative retiming. Transform
visits all its stored track keyframes, including those after the duration, through
a track-local stored-keyframe cursor whose preview uses the nearest available frame.
Speed uses a clip-local stored-source cursor; both are independent of central track
inspection, so successive stored keyframes remain reachable even when their nearest
preview image is the same. Stored time stays distinct from actual preview.
Enabled setting chips in stored Colour keyframe rows carry per-channel native arrows
too. All main and stored per-channel arrows visit strictly earlier/later keyframes
where that channel is nonnull (zero is enabled), sharing the central off-duration
inspection cursor with section navigation to track keyframes and track/list
navigation. Main capture always uses the real displayed project/source frame,
never an inspected stored time. All visible
track/Transform/clip-speed easing labels read **Easing**, retaining contextual
accessible names such as **Track keyframe easing N**.

Inside timeline clip rectangles, a boxed salmon **●** custom-speed lane places
source keyframes at authoritative retimed output positions. Off-trim keyframes are
omitted; exclusive OUT has a boundary marker seeking the final available frame.
Click, Enter or Space selects the clip, seeks its nearest mapped image and opens
Clip → Speed; a click edits nothing. Speed keys slide by drag or ←/→ (one source
frame, Shift ten), one Undo step per valid release, retiming their clip. Track
Transform keyframes are boxed blue **▼** markers at the top of the track row, one
per stored keyframe at its project frame (a default keyframe is filled light blue
with the default-keyframe icon). Click or Enter selects the track, seeks and opens
Track → Transform; they slide by drag or ←/→ (one project frame, Shift ten), one
Undo step per valid release. Marker keyboard events are isolated from timeline
shortcuts. These presentation changes leave math, storage, retiming algorithms and
resource bounds unchanged.

Every sliding timeline keyframe marker (shared track, Transform and speed, and any future
type) uses one implementation, [keyframe-slide.tsx](../src/web/keyframe-slide.tsx):
`useKeyframeSlide` owns pointer capture, the 3-pixel threshold, snapping (8 px to
captured boundaries and playhead; Alt bypasses), edge autoscroll,
preview following the dragged key, the red ghost at an invalid target, Escape/blur
cancellation, one Undo step per valid release, ←/→ moves and focus; `KeyframeMarkers`
renders one element per stored key whose React key survives the drag. A keyframe
type supplies only a `KeyframeSlideKind`: frame mapping, validation, seek
and Properties section. Plain keys stay with a focused marker; Undo/Redo still apply.

**Clip → Range** uses one full-original hatched bar with IN/OUT handles and exact
text fields below its ends, displaying 30 fps NDF **MM:SS:FF** and accepting
whole original frames or timecode on Enter/blur. Invalid drafts remain editable;
Escape restores. No duplicate duration/original/source-frame/head-tail labels.
Fields/bar use ordinary source-range trim with fixed placement and normal Ripple
suffix sequencing, not the timeline left handle's retained-OUT rule. Drag previews
the complete validated document; final valid release is one Undo, invalid final/
cancel/lost capture/blur restores. Arrows move one original frame (Shift ten),
Home/End restore IN/OUT endpoints; Restore full recording stays. Source review's
independent numeric IN/OUT pair (Enter/blur applies, Escape restores) is unchanged. See [Range](TIMELINE_EDITING.md#clip-range).

## Contributor safety

- Follow [the GitHub workflow](GITHUB_WORKFLOW.md): routine changes go straight to
  `main` after the fast local gate; risky changes use a short-lived PR. Never stash,
  reset, discard or commit unrelated uncommitted work.
- Saved projects, registries and receipts must stay backward compatible unless the
  owner explicitly waives it: an incompatible change ships its upgrade step and a
  frozen fixture, and data a build cannot open is rejected clearly and left
  unchanged. Follow the [data compatibility workflow](GITHUB_WORKFLOW.md#data-compatibility).
- Never modify/copy/delete owner's originals or commit private paths/device IDs,
  saved project IDs, real media/cache or reports. Preserve fingerprints, symlink
  rejection, cache exclusion and HTTP guards.
- Keep **the strict current schema**: required project `bookmarks` (at most 1,000 unique ascending
  frames, editing aids only) and `selects` (kept source ranges per recording) and complete required video track `colour`, including
  Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local contrast and static HSL/curves; reject saved `clip.colour`
  and `clip.correction`. Grade sources once with evaluated track Colour, retaining
  two LUT buffers and existing raw/process budgets. Main Colour controls and keyframes
  have identical track scope and work empty. Required track `transform` (base and
  project-frame keyframes) has the same scope; reject saved `clip.spatial`. See
  [track appearance](design/ROW_APPEARANCE.md). Required static clip `detail` and boolean `reverse`,
  required unique video/audio membership, all fifteen nullable
  channels and per-track `ripple`, `transitions`, `openingFade`, `closingFade` and
  numeric `opacity` in 0–1. A new track starts at 1; a missing saved field is invalid.
  The channels are `opacity` (sole UI **Opacity**), `temperature`, `tint`,
  `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`, `shadows`,
  `whites`, `blacks`, `hdr`, `localContrast`.
  Missing bases/channels are invalid; neutral values are creation values only.
  Track `opacity` is the sole valid stored value; reject saved `clip.opacity`
  and old `clipOpacity`/`layerOpacity` channels. No project-level
  transitions/fades, compatibility fields/defaults or mandatory first-track
  ID. Require a 0–8 `music` array with unique instance IDs and complete independent
  settings, plus captured audio-source/instance-plan arrays in current receipts.
  Reject and preserve projects/receipt snapshots older than the oldest supported schema
  and finished videos, without automatic deletion. Proxy formats,
  source protections and native resource budgets remain unchanged; the registries are
  version 2 (full-content checksums).
- Reuse `JobQueue`, library and backpressured raw/retime helpers: one heavy job,
  bounded threads/buffers, cancellation and owned-scratch cleanup. Keep serial awaits/
  [serial helpers](../src/shared/serial.ts), not parallel media work to satisfy lint.
- Preserve exact frame/packet/source-map, pixel-error, audio and resource assertions.
  Investigate EOF/timing failures; no weaker checks, silent clamping/fallback,
  warning suppression or analysis exclusions.
- The project uses the approved [MIT license](../LICENSE); third-party/native
  components and private media keep their own terms. Follow [licensing](LICENSING.md)
  before any binary/image distribution; source publication is not release approval.
  Preserve [../EDITOR_IMPLEMENTATION_PLAN.md](../EDITOR_IMPLEMENTATION_PLAN.md);
  planning/feature worksheets are scope inputs, not code/assets to copy.
