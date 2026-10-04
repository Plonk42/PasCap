# Development

Local Linux setup and contributing. Editing: [USER_GUIDE.md](USER_GUIDE.md). Service
paths and **future, not implemented** containers: [DEPLOYMENT.md](DEPLOYMENT.md).

## Requirements

- **Linux**, npm, **Node 22 LTS ≥22.12.0 or 24 LTS** (`>=22.12.0 <25`). Validation
  targets 22/24, not every intervening major version.
- **FFmpeg/ffprobe 8.0.1**, the tested baseline; FFmpeg 6 is unqualified.
  Other builds need parity tests. Require `libx264`, FFV1, AAC, `lut3d`/`xfade`, raw
  RGB/lossless RGBA16 and the existing timing/colour filters and bitstream tools.
- Browser **WebGL2**/`requestVideoFrameCallback`; tests use installed **Google Chrome**
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

| Variable | Meaning |
| --- | --- |
| `PASCAP_DATA_DIR` | Generated-data directory; defaults to the ignored `.pascap/` |
| `PASCAP_MEDIA_ROOTS` | JSON array of up to 32 unique absolute browser roots; defaults to the service user's Videos folder; `[]` disables browsing only |
| `PASCAP_PORT` | Unprivileged loopback service port, default 4318 |
| `PASCAP_FFMPEG` / `PASCAP_FFPROBE` | Native executable paths, otherwise resolved from PATH |
| `PASCAP_MEASURE_URL` | Editor URL/project used by the optional measurement helper |

For example, start with an explicit approved root (literal `~` is not expanded):

```sh
PASCAP_MEDIA_ROOTS='["/home/you/Videos","/mnt/footage"]' npm run dev
```

Generated data is not an original-footage backup; keep it outside footage. It holds
registries, proxies/thumbnails, projects, exports/receipts, measurements and scratch.
Original paths remain identity-checked even with ready proxies; no implicit relink/
migration exists. Preserve registered bytes/paths, including previously copied sources.
The browsing/registration API table and mount/security contract live in
[DEPLOYMENT.md](DEPLOYMENT.md#no-copy-source-access-today), not a second API table here.

## Validation

```sh
npm run check
npm run test:media
npx playwright install --with-deps chrome
npm run test:browser
```

- `check` runs strict frontend typechecking, unit/service tests and the production
  build/server typecheck. `npm test` runs Vitest; native tests require `test:media`.
- `test:media` uses disposable temporary **synthetic** sources/projects/outputs only.
- `test:browser` builds/creates synthetic fixtures, then runs serial Chrome workflows
  on its own service at **4320**, without reusing a running service.
- `npm run test:space` is an additional explicit Linux native check using `unshare`,
  `mount` and `umount` with unprivileged user namespaces. It exhausts a private
  32 MiB tmpfs, never a shared disk or host mount, and needs no sudo. The ordinary
  native suite does not enable this platform-specific test implicitly. Run both
  native suites together with `PASCAP_MEDIA_TESTS=1 PASCAP_SPACE_TESTS=1 npm test -- tests/media`.
  Hosts forbidding user namespaces must not claim that acceptance from unit mocks.

**Browser fixture setup resets `.pascap/browser-tests/`**; never store personal work
there. It seeds twelve video memberships, music and proxies. Separate import-test
originals in `.pascap/browser-footage/synthetic-sources/` are outside that cache;
`browse-camera-*` means generated patterns, not real recordings. The
[fixture factory](../scripts/fixtures.ts) uses `preview-lab-v5` outside the browser
cache and `preview-lab` inside it; bin resets never imply a global-library fallback.
Neither suite invokes real-source sample preparation or needs private footage/music.

### Recorded local baseline

**2026-10-04 local baseline: 876 unit/service + 185 browser + 54 native = 1,115
tests**, strict typechecks/build passing. The native total includes the separately
enabled private tmpfs test. [Evidence/history](DELIVERY_STATUS.md#current-clip-speed-verification)
is recorded separately from new CI results and target-GPU, long-run memory/A/V or
complete 5–10 minute real-flight qualification. Complete unit suites passed on
local Node 22.23.3 and 24.21.0; the final browser/native suites used Node 22.
The 1,039-test UX-hardening baseline remains historical rather than being relabelled.

The later [inline-help UI verification](DELIVERY_STATUS.md#current-help-popover-verification)
records the completed hover/pin/dismiss checks separately. The current
[heading-placement verification](DELIVERY_STATUS.md#current-heading-help-verification)
adds collapsed-title access, independent native expansion/help, mounted drafts
and compact geometry coverage without changing the native pipeline;
the older 54 native/private-tmpfs results are not claimed as a new run.

### GitHub CI

The [workflow](../.github/workflows/ci.yml) is committed with the initial repository
publication. Its first remote run is separate evidence from the local baseline:

- Linux unit/typecheck/build checks on **Node 22 and 24**.
- Native/media and Chrome/browser checks on **Node 22**, using **FFmpeg/ffprobe
  8.0.1 built from pinned source** via a setup script/cached toolchain, not runner
  apt FFmpeg 6 or an implied untested version-support claim.
- `push`, `pull_request` and `workflow_dispatch` triggers; read-only repository
  permissions, dependency/toolchain caching and failure-only outputs including
  retained Playwright traces/screenshots.
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

The raw-reader EOF tracked as [#1](https://github.com/Plonk42/PasCap/issues/1)
now has a local deterministic exit-before-read regression and eager bounded-read
fix. CI does not retry tests to hide it; fresh remote-runner evidence remains
separate. [UX_HARDENING.md](UX_HARDENING.md) records the cause, identity limitations,
storage evidence and loading boundaries.

The three-recording playback completion check has a bounded 45-second wait inside
a 60-second test, with renderer/decoder diagnostics. The first runner trace showed
steady progress but did not complete 144 frames inside its original 15-second
deadline. End-frame/error/two-decoder assertions are unchanged: this is correctness
on software rendering, not the intended-GPU throughput gate.

## Optional real-media tools

**Do not run these in CI or without the owner's explicit approval for real jobs.**
The [sample helper](../scripts/prepare-samples.ts) targets **DJI_0468.MP4 and DJI_0469.MP4
only**: pass an **explicit folder after `--`**, never rely on a personal-path default.
It reuses ready proxies but may prepare missing ones; creates only an absent v5
sample, never overwrites or migrates existing edits.

The [measurement helper](../scripts/measure-preview.ts) accepts exactly **two
primary 1× excerpts**, no music, extra layers, non-unit opacity or shared row points
(even neutral/Speed-only points). `PASCAP_MEASURE_URL` selects that project.
`npm run measure -- --skip-playback --reference` skips playback benchmarking but
**renders a native reference**; `--headed --reference` adds repeated playback. The edit
is not saved, but reports/output are written. Keep the tab visible and check the
**actual renderer**, not assumed discrete-GPU Chrome. Heap excludes decoder/driver/
total-process memory; reports expose private paths/snapshots, so review before sharing.
[FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md) records historical scope, not GPU qualification.

## Architecture

| Boundary | Entry points | Responsibility |
| --- | --- | --- |
| Shared | [Model](../src/shared/model.ts), [commands](../src/shared/commands.ts), [layout](../src/shared/timeline.ts), [row retiming](../src/shared/layer-retiming.ts) | Strict data, integer-frame timing, atomic edits; no React/browser/FFmpeg dependencies |
| Preview | [Engine](../src/preview/engine.ts), [decoder](../src/preview/decoder.ts), [compositor](../src/preview/compositor.ts), [music](../src/preview/music.ts) | Observed frames, decoder reuse, WebGL2/Web Audio; independent of React |
| Web | [App](../src/web/App.tsx), [autosave](../src/web/autosave.ts) | Panels, contextual controls, transient pointer/input drafts, session history and serial saves |
| Service | [HTTP app](../src/server/app.ts), [library](../src/server/library.ts), [jobs](../src/server/jobs.ts), [layered export](../src/server/layered-export.ts) | Guarded registered-source access, bounded native work and verified immutable exports |

Preview reuses **two decoders for one layer, up to nine for eight**, plus one source
reviewer, not one per clip. Layered export: one original decoder, two intermediate
readers/one encoder maximum; raw buffers **116.1 MB at 4K** + LUTs **6.6 MB** + native
memory. Two clip files/two timeline representations bound concurrency, **not disk GB**;
scratch grows with duration ([resource contract](DELIVERY_STATUS.md#resource-contract)).
Processing: [row points](LAYERS_AND_KEYFRAMES.md), [retiming/audio](SPEED_AND_AUDIO.md)
and [grading equations](COLOUR_AND_TIMING.md#colour).

## Contributor safety

- Never modify/copy/delete owner's originals or commit private paths/device IDs,
  saved project IDs, real media/cache or reports. Preserve fingerprints, symlink
  rejection, cache exclusion and HTTP guards.
- Keep **strict schema 5**: required unique video/audio membership and all ten nullable
  channels; no compatibility fields/defaults/migration/backports for old local data.
  Preserve incompatible files and finished videos.
- Reuse `JobQueue`, library and backpressured raw/retime helpers: one heavy job,
  bounded threads/buffers, cancellation and owned-scratch cleanup. Keep serial awaits/
  [serial helpers](../src/shared/serial.ts), not parallel media work to satisfy lint.
- Preserve exact frame/packet/source-map, pixel-error, audio and resource assertions.
  Investigate EOF/timing failures; no weaker checks, silent clamping/fallback,
  warning suppression or analysis exclusions.
- No project license is declared; do not assume MIT or redistribute private media.
  Preserve [../EDITOR_IMPLEMENTATION_PLAN.md](../EDITOR_IMPLEMENTATION_PLAN.md);
  planning/feature worksheets are scope inputs, not code/assets to copy.



