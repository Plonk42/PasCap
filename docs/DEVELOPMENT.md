# Development

Current strict schema **12** requires nine scalar bases in each row's `colour`,
including Temperature/Tint (−1…1, neutral 0), all eight HSL bands and all four
colour curves. Shared points require eleven nullable fields, in control order:
`opacity`, `speed`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`,
`hue`, `saturation`, `highlights`, `shadows`. HSL/curves remain static.
Reject/preserve v1–v11 documents and receipt snapshots; no load defaults,
migrations, legacy acceptance or automatic deletion. CPU/reference/native/GPU
must use the same [Temperature/Tint gain math](design/TEMPERATURE_AND_TINT.md)
before Exposure, including intentionally coloured greys and pre-clipping
neutral-white linear luminance normalization only. Required synthetic validation
retains neutral identity, axis signs/combined grades, grayscale/HSL boundaries,
GPU uniform capacity, exact native sharp knees and unchanged pixel/frame/resource
gates; this update claims no new test results. Nonneutral HSL/curves use exact
complete CPU grading through layered export; neutral advanced settings retain
scalar LUT paths. At most two native 65³ Float32 buffers (6,591,000 bytes) remain
available, without an extra decoder, texture, full-frame buffer or child process.
Exact advanced grading can substantially slow UHD exports. See
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md). New reference/measurement metadata
identifies strict schema 12; historical reports remain unchanged.

Local Linux setup and contributing. Editing: [USER_GUIDE.md](USER_GUIDE.md). Service
paths and **future, not implemented** containers: [DEPLOYMENT.md](DEPLOYMENT.md).

## Requirements

- **Linux**, npm, **Node 22 LTS ≥22.12.0 or 24 LTS** (`>=22.12.0 <25`). Validation
  targets 22/24, not every intervening major version.
- **FFmpeg/ffprobe 8.0.1**, the tested baseline; FFmpeg 6 is unqualified.
  Other builds need parity tests. Require `libx264`, FFV1, AAC, `lut3d`/`xfade`, raw
  RGB/lossless RGBA16 and the existing timing/colour filters and bitstream tools.
- Browser **WebGL2**/`requestVideoFrameCallback` and **AudioWorklet**/`getOutputTimestamp`
  for music; tests use installed **Google Chrome**
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

| Variable                           | Meaning                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASCAP_DATA_DIR`                  | Generated-data directory; defaults to the ignored `.pascap/`                                                                                                                                 |
| `PASCAP_MEDIA_ROOTS`               | JSON array of up to 32 unique absolute roots shared by footage/music browsing; defaults to the service user's Videos folder; `[]` disables both browsers, not deliberate manual path imports |
| `PASCAP_PORT`                      | Unprivileged loopback service port, default 4318                                                                                                                                             |
| `PASCAP_FFMPEG` / `PASCAP_FFPROBE` | Native executable paths, otherwise resolved from PATH                                                                                                                                        |
| `PASCAP_MEASURE_URL`               | Editor URL/project used by the optional measurement helper                                                                                                                                   |

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

- `npm run format` applies Prettier ([configuration](../.prettierrc.json)) to the
  repository; `check` first verifies that formatting with `format:check`.
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
  --grep 'streaming music clock|streamed PCM|with music normal speed|held sources|withheld decoded callback|with music and a callback-gated cancellation|native-event-ordered video catch-up|Playing publication rechecks'
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
The memory-only fixture remains 480 project frames; no clock forgery, throughput
threshold or enlarged playback timeout is used.

On a rejected graphics result, the prerequisite also runs the installed Firefox
bundle's native `gfxtest glx` once in the same display/Mesa environment, with a
five-second deadline and 32 KiB limit per output stream. It logs and retains the
browser/context result, selected graphics environment and native EGL/GLX output
in the failure artifacts. A successful native GLX probe cannot qualify a rejected
browser WebGL2 context; there is no context retry, force-enable or fallback.
The privileged `about:support` page is not navigable through this Firefox build's
Playwright/Juggler integration, so it is not used as a potentially hanging diagnostic.

Firefox gives its own startup GLX probe four seconds (`GFX_TEST_TIMEOUT`); if that
probe is late, Firefox blocks WebGL2 for the whole session (`AllowWebgl2:false`).
Hosted runs showed this intermittently while the native probe immediately
afterwards succeeded, consistent with a cold first load of Mesa/LLVM. The
prerequisite therefore runs the same bundled `gfxtest glx` once **before**
launching Firefox and logs its duration. This only loads libraries: Firefox still
runs its own probe and must create the real WebGL2 context; the warm-up result
is evidence, never a gate, retry or capability override.

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
readiness remains an actionable hard failure before the ten media tests. Neither
prerequisite changes the editor's ten-second music-start deadline or test bounds.

The [music-clock regression](../tests/browser/music-clock.spec.ts) requires one
uninterrupted music start from zero or a nonzero seek, bounded range reads and
actual rendered stereo PCM amplitude/placement silence. Its bounded audio-thread
observer checks every sample in the required frame windows, not UI-thread snapshots
that can miss complete frames under load. The selected recovery tests
retain the independent one-frame audio/video bound, 0.1× held-source video-only
and music recovery, an explicit withheld-callback deadline failure, pause/seek/restart, genuine
callback-gated cancellation and native-event-ordered video catch-up without
restarting music. The catch-up case starts from source frame 4, holds and pauses
on a genuine advancing playback callback (never a pending seek), then releases the callback
chain on the recovery's actual native seek event. Release never waits for that
withheld metadata to match an advancing clock; exact readiness remains the real
decoder's responsibility. Deterministic engine tests separately control between-
display-tick delivery, delayed seek/play/cancellation/deadlines and replay observed /
requested / delivered schedules **4/7/14, 9/12/11 and 9/12/12**, without guessing
images or weakening bounds. The post-render clock/surface check also covers bounded
synchronous draw work while real output audio advances. These ten synthetic,
memory-only browser checks run in CI;
they do not qualify the entire Firefox editor or intended hardware. Attachments
contain bounded consumed-sample/output-timestamp evidence and at most 500
decoder/clock state snapshots around music transitions, not private media.
Recovery failures also retain at most ten independent A/V violation witnesses:
the offending state, raw receipt/output timestamps and observation interval.
These diagnostics never change the frame comparison, tolerance or result.
During non-busy decoded-frame buffering, real video-frame delivery can accept an
exact current-clock frame or eligible one-frame neighbour between display ticks,
resetting only the resolved mismatch's grace period. It cannot accept an obsolete
request, bypass music sync/full clip-set/source checks, resume pending/cancelled
seeks or hide genuine persistent gaps. With healthy music and the same active
clips, a longer video-only mismatch stays explicitly buffering while an owned
seek catches up to the advancing audio clock; it does not restart/reanchor music.
Current exact/one-frame source readiness is rechecked after seeking and starting
video. Catch-up has one five-second deadline, not a fresh deadline per target;
failure, pause or cancellation stops owned work. Actual music sync failures and
clip-set boundaries retain full alignment and its explicit audio restart.
A paused decoder seek completes only on the requested frame's real video-frame
callback. Gecko numbers paused redraws from a container counter but played frames
with decoder IDs, and skips a callback whose ID equals the last presented frame:
after playback, a paused redraw can collide and never be reported. A decoder that
has played therefore waits two rendering updates after the native `seeked` event
(video-frame callbacks run before animation frames); if the requested frame is
still unreported, it seeks the same target once more, presenting a fresh ID with
exact metadata. This stays within the five-second required-frame deadline, so a
genuinely withheld callback still fails explicitly. There is no currentTime
identity, retry loop, skipped assertion, privacy change or larger bound.

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
versions; newly generated documents must satisfy strict v12, including complete row
colour with Temperature/Tint, all eleven nullable channels and clip spatial
base/full-pose keys. Bin resets never imply
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
   readable values, reachable controls and scrolling, at a desktop and a compact
   viewport (plus short/narrow cases when affected; see the
   [responsive matrix](WORKSPACE_AND_RECOVERY.md#layout-and-navigation)).
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
Playback recovery checks record requested project frames, observed source frames
and decoder readiness. An unchanged single-source image within one project frame
must not buffer unnecessarily; every additional video-only buffer needs evidence
that no exact neighbour or retainable accepted image was available. A deliberately
withheld real callback verifies genuine larger delays remain explicit. Neither a
universal stall count nor a software-renderer FPS threshold qualifies hardware.
Playback also rechecks the actual audio-output clock after synchronous rendering,
including ticks between throttled notifications. An image that was eligible before
upload/draw but is now stale must clear and buffer without restarting healthy music.
A bounded native WebGL draw-delay regression checks the post-render status against
independently observed output audio. Chrome exposes output-clock advancement during
synchronous JS: the test requires advancement beyond every eligible neighbour and
explicit buffering with a black surface. Firefox may cache its native timestamp
until the task yields; its post-render Playing image must still meet that actual
clock's one-frame bound. Neither case changes clocks or receipts, and both retain
the independent one-frame A/V, single-epoch and completion assertions.

## Optional real-media tools

**Do not run these in CI or without the owner's explicit approval for real jobs.**
The [sample helper](../scripts/prepare-samples.ts) targets **DJI_0468.MP4 and DJI_0469.MP4
only**: pass an **explicit folder after `--`**, never rely on a personal-path default.
It reuses ready proxies but may prepare missing ones; creates only an absent v12
sample, never overwrites or migrates existing edits.

The [measurement helper](../scripts/measure-preview.ts) accepts exactly **two
1× excerpts on one enabled, zero-origin contiguous track with row Opacity 1**, no music,
extra layers, spatial edits/keys or shared row points
(even neutral/Speed-only points). `PASCAP_MEASURE_URL` selects that project.
Measurement uses static scalar row Colour (including Temperature/Tint), neutral
HSL and identity curves; metadata must identify the strict v12 snapshot independently of the
report format/identifier; historical reports and receipt snapshots stay untouched.
`npm run measure -- --skip-playback --reference` skips playback benchmarking but
**renders a native reference**; `--headed --reference` adds repeated playback. The edit
is not saved, but reports/output are written. Keep the tab visible and check the
**actual renderer**, not assumed discrete-GPU Chrome. Heap excludes decoder/driver/
total-process memory; reports expose private paths/snapshots, so review before sharing.
[FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md) records historical scope, not GPU qualification.

## Architecture

| Boundary | Entry points                                                                                                                                                 | Responsibility                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Shared   | [Model](../src/shared/model.ts), [commands](../src/shared/commands.ts), [layout](../src/shared/timeline.ts), [row retiming](../src/shared/layer-retiming.ts) | Strict data, integer-frame timing, atomic edits; no React/browser/FFmpeg dependencies         |
| Preview  | [Engine](../src/preview/engine.ts), [decoder](../src/preview/decoder.ts), [compositor](../src/preview/compositor.ts), [music](../src/preview/music.ts)       | Observed frames, decoder reuse, WebGL2/Web Audio; independent of React                        |
| Web      | [App](../src/web/App.tsx), [autosave](../src/web/autosave.ts)                                                                                                | Panels, contextual controls, transient pointer/input drafts, session history and serial saves |
| Service  | [HTTP app](../src/server/app.ts), [library](../src/server/library.ts), [jobs](../src/server/jobs.ts), [layered export](../src/server/layered-export.ts)      | Guarded registered-source access, bounded native work and verified immutable exports          |

Preview reuses **two decoder/texture slots per track, up to 16 for eight**, plus one
source reviewer, not one per clip. Each track can dissolve independently. Generalized
layered export renders premultiplied RGBA16 track groups. Every `VideoLayer`
requires numeric `opacity` in 0–1, initially 1 (100%) on new tracks. Evaluate that
row value or its sole overriding `opacity` key channel for each source, including
both dissolve sources; there is no saved `clip.opacity` or second opacity channel.
With graded RGB $G_i$,
black-fade brightness $b_i$, Opacity $o_i$, dissolve weight $w_i$ and per-pixel
spatial coverage $m_i$, group RGB is $C = \sum_i G_i b_i o_i w_i m_i$ and
coverage is $A = \sum_i o_i w_i m_i$.
Groups merge bottom-to-top as $\mathrm{result} = C + \mathrm{lower}(1 - A)$,
without regrading or another opacity multiplier. Opacity is composition coverage,
not SDR RGB grading; unkeyed colour settings are row-owned. Black fades preserve coverage;
each dissolve remains one group. Serial limits: one original decoder, two intermediate readers,
one encoder and three native video children per pass. Four raw buffers (two RGB8,
two RGBA16) use **22 bytes/pixel = 182,476,800 bytes at UHD**; two 65³ Float32 LUTs
add **6,591,000 bytes**, excluding native/audio memory. Two retained clip files and
three timeline representations bound concurrency, **not disk GB**;
scratch grows with duration ([resource contract](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits)).
The static fast path requires one enabled, unanimated, zero-origin contiguous
track with row Opacity 1, neutral HSL/identity colour curves and exactly neutral spatial bases without spatial keys;
any spatial edit/key (even neutral keys) or unsupported placement/coverage uses
generalized layered export, regardless
of Ripple or track ID.
Processing: [row points](LAYERS_AND_KEYFRAMES.md), [retiming/audio](SPEED_AND_AUDIO.md)
and [grading equations](COLOUR_AND_TIMING.md#colour).

Strict schema 12 requires `clip.spatial: { base, keyframes }`: eight complete pose
values and 0–256 full-pose original-source keys with required easing. Shared
[spatial mapping](../src/shared/spatial.ts) uses unrounded original-aspect contain
fit, original-centre pivot and half-open crop bounds; crop does not refit.
`PlacedClip.retiming.sourcePositionAt` supplies continuous geometry while
`sourceAt` supplies recorded-image identity, allowing geometry on held images
without optical flow. Exact neutral poses preserve old opaque black letterboxing
after grading; nonneutral uncovered pixels have zero coverage. Native inverse
RGB resampling precedes grading, reusing the same four raw buffers/two LUTs and
serial process limits. Source keys remain at their original anchors through
trim/cut/split/duplicate/move; new pieces have independent deep copies. The fifth
Clip section **Transform** is collapsed by default and uses explicit full-pose
source-frame capture, stored-key navigation and release-only sliders. See
[the spatial contract](design/SPATIAL_TRANSFORMS.md), not historical benchmark
reports, for current geometry/schema/UI facts.

Up to eight independently identified music instances share one bounded mixed queue,
AudioContext/worklet and output clock. Apply each source's gain/fades, sum linearly,
then clamp once after the full mix. Native audio stays serial: one original decoder,
at most two intermediate inputs and three scratch files (selected PCM plus old/new
Float64 accumulators). Audio storage planning is maximum selected PCM plus two full
project accumulators. Project duration includes every music OUT; absent active video
is opaque black, not a held last image, while music continues/fades at its own OUT.
Video closing fades remain inside their last clips. The static export path must
cover the full project; music tails use layered export. Export still requires video.
See [the multiple-music contract](design/MULTIPLE_MUSIC.md).

The single **Opacity** slider/diamond/navigation belongs in **Clip → Colour**
alongside the colour sliders, initially **100%**, and works on an empty row.
Without Opacity keys, it edits row `opacity`; with keys, only participation at the
real playhead permits editing, with the diamond explicitly capturing a missing
participant. Sliders never create keys. **Placement** contains placement only;
Layer options contains rename, Ripple, ordering and deletion, with visibility separate.

## Contributor safety

- Follow [the GitHub workflow](GITHUB_WORKFLOW.md): routine changes go straight to
  `main` after the fast local gate; risky changes use a short-lived PR. Never stash,
  reset, discard or commit unrelated uncommitted work.
- Before the first release candidate, approved changes may break existing projects
  and persisted formats: favour one current strict implementation, not backward-
  compatibility boilerplate. Do not add unrequested migrations, legacy fields,
  fallback readers/defaults or compatibility-only tests. Update affected tests/docs,
  disclose incompatibility and recreation/reset needs, and preserve existing files
  rather than silently rewriting/deleting them. Agree the post-RC1 policy with the
  owner before RC1; follow the [pre-RC compatibility workflow](GITHUB_WORKFLOW.md#compatibility-before-the-first-release-candidate).
- Never modify/copy/delete owner's originals or commit private paths/device IDs,
  saved project IDs, real media/cache or reports. Preserve fingerprints, symlink
  rejection, cache exclusion and HTTP guards.
- Keep **strict schema 12**: complete required row `colour`, including
  Temperature/Tint and static HSL/curves; reject saved `clip.colour`
  and `clip.correction`. Grade sources once with evaluated row Colour, retaining
  two LUT buffers and existing raw/process budgets. Main Colour controls and keys
  have identical row scope and work empty. See [row appearance](design/ROW_APPEARANCE.md). Required clip spatial base/full-pose source-frame keys,
  required unique video/audio membership, all eleven nullable
  channels and per-layer `ripple`, `transitions`, `openingFade`, `closingFade` and
  numeric `opacity` in 0–1. A new track starts at 1; a missing saved field is invalid.
  The channels are `opacity` (sole UI **Opacity**), `speed`, `temperature`, `tint`,
  `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`.
  Missing bases/channels are invalid; neutral values are creation values only.
  Row `opacity` is the sole valid stored value; reject saved `clip.opacity`
  and old `clipOpacity`/`layerOpacity` channels. No project-level
  transitions/fades, compatibility fields/defaults/migration or mandatory first-track
  ID. Require a 0–8 `music` array with unique instance IDs and complete independent
  settings, plus captured audio-source/instance-plan arrays in current receipts.
  Reject and preserve incompatible v1–v11 projects/receipt snapshots and finished videos,
  without automatic deletion; recreate projects deliberately. Registry/proxy formats,
  source protections and native resource budgets remain unchanged.
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
