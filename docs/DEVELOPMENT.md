# Development

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

- `check` runs strict frontend typechecking, unit/service tests and the production
  build/server typecheck and locked production-license inventory. Builds retain the
  upstream notice texts in a served notice artifact; `npm run licenses:check`
  verifies the inventory without building/writing. See [licensing](LICENSING.md).
  `npm test` runs Vitest; native tests require `test:media`.
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
Firefox profile. Install it with `npx playwright install firefox`; after the
ordinary build and clean browser fixture setup, run
`npx playwright test --config=playwright.firefox.config.ts tests/browser/music-clock.spec.ts tests/browser/playback-recovery.spec.ts --grep 'streaming music clock|streamed PCM|with music normal speed|with music and a callback-gated cancellation'`.
The [music-clock regression](../tests/browser/music-clock.spec.ts) requires one
uninterrupted music start from zero or a nonzero seek, bounded range reads and
actual downstream PCM amplitude/placement silence. The selected recovery tests
retain the independent one-frame audio/video bound, pause/seek/restart and genuine
callback-gated cancellation. These five synthetic, memory-only checks run in CI;
they do not qualify the entire Firefox editor or intended hardware. Attachments
contain bounded consumed-sample/output-timestamp evidence, not private media.
The complete optional Firefox recovery suite still exposes a separate 0.1× video
seek/rVFC readiness failure, also reproducible without music. Do not hide it with
a currentTime guess, retries, skipped assertions, privacy changes or a larger bound.

### Incremental feedback

The validation commands above are complete entry points, not a mandatory chain
after every edit. Follow the [work-cycle gates](GITHUB_WORKFLOW.md#efficient-development-and-delivery):
focused feedback during implementation, applicable comprehensive checks before
PR submission, then asynchronous required PR CI before merge. Keep explicit issue
acceptance intact. Publish logical-step commits on short-lived branches; never push
directly to protected `main`. Format/save/review and validate the exact head's
non-CI acceptance before arming native squash auto-merge. A full-delivery PR may
then use `Closes #N` in its description; partial work merely references its issue.

- While editing, use `npm test -- tests/unit/<affected-file>.test.ts` or
  `npm run test:watch -- tests/unit/<affected-file>.test.ts`; use relevant spec paths
  or Playwright `--grep` for focused browser feedback. Native tests remain an
  explicit synthetic opt-in when affected; ordinary `npm test` does not enable them.
- For a code-delivery cycle, `npm test` followed by `npm run build` covers the same
  unit/service, frontend/server types, production build and license checks as
  `npm run check`, without its duplicate leading frontend typecheck. `check` remains
  supported; do not run both equivalent chains on unchanged inputs or append another
  standalone build/typecheck without a reason. Scripts are unchanged.
- If that cycle already built the current inputs, prepare isolated browser fixtures
  with `npx tsx scripts/fixtures.ts --browser`, then run `npx playwright test` (or
  affected specs), instead of rebuilding through `npm run test:browser`. The latter
  remains the self-contained build/setup/full-suite entry point. Install Chrome when
  missing, not on every focused run.
- Reuse a build only while relevant source/configuration/dependency/toolchain inputs
  are unchanged. Reuse fixtures only if prior tests leave the required baseline
  intact; reseed after state-changing runs as needed. A full acceptance run starts
  from the documented clean fixture baseline, not an assumed clean focused run.
- Never run build/check or fixture setup while a browser suite serves that output or
  cache. Complete unit/type/build phases first, then run browser validation against
  immutable output. Keep shared browser/media runs serial; additional workers need
  verified isolation first. Parallel subagent reviews must use file/search tools only,
  never terminal commands that could interrupt an active validation command.
- Record exactly which checks passed on which inputs. Focused checks do not replace
  an applicable full suite; invalidate affected results after further relevant edits.
  Documentation-only work uses content/link/whitespace checks and review, not this
  runtime chain. Do not shorten timeouts, retry failures or weaken tests for speed.

**Browser fixture setup resets `.pascap/browser-tests/`**; never store personal work
there. It seeds twelve video memberships, music and proxies. Separate import-test
originals in `.pascap/browser-footage/synthetic-sources/` are outside that cache;
`browse-camera-*` means generated patterns, not real recordings. The
[fixture factory](../scripts/fixtures.ts) uses `preview-lab-v6` outside the browser
cache and `preview-lab` inside it; bin resets never imply a global-library fallback.
Neither suite invokes real-source sample preparation or needs private footage/music.

The [music-browser regression](../tests/browser/music-browser.spec.ts) uses memory-only
projects and the existing prepared synthetic WAV. It copies that generated test WAV
into one temporary subfolder of the isolated approved browser root (the fixture's
original path is inside the excluded cache), then removes only that owned subfolder.
Normal navigation/confirmation exercise the guarded audio routes; unavailable locations,
access/probe/write failures and stale reads use disposable route responses. No fixture
generator/reset, private audio, music placement or export is needed.

### Verification evidence

Record dated results on the corresponding [GitHub work issue](https://github.com/Plonk42/PasCap/issues):
exact commit, toolchain, commands, passed/failed checks and remaining acceptance.
Keep local checks, [actual-commit CI](https://github.com/Plonk42/PasCap/actions)
and consented intended-GPU/real-flight qualification separate. Never add historical
native counts to a fresh UI run or describe an older green run as current delivery
evidence. Follow [the delivery workflow](GITHUB_WORKFLOW.md#merge-closure-and-reconciliation).

### GitHub CI

The [workflow](../.github/workflows/ci.yml) runs:

- Linux unit/typecheck/build checks on **Node 22 and 24**.
- Native/media, full Chrome/browser and scoped Firefox music checks on **Node 22**, using **FFmpeg/ffprobe
  8.0.1 built from pinned source** via a setup script/cached toolchain, not runner
  apt FFmpeg 6 or an implied untested version-support claim.
- PRs targeting `main`, pushes to `main` and `workflow_dispatch`; read-only repository
  permissions, dependency/toolchain caching and failure-only outputs including
  retained Playwright traces/screenshots.
- An unconditional **Delivery gate** succeeds only if the Node matrix and native/
  browser job both return `success`, rejecting skipped/cancelled/failed prerequisites.
  Protected `main` requires all three suite checks plus this gate from GitHub Actions,
  with the PR branch up to date; administrators cannot bypass protection.
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

Required up-to-date PR CI is the merge/closure gate; main push CI is a regression
backstop, not a second closure wait. After exact-head non-CI acceptance, native
auto-merge waits and merges eligible PRs independently of the editor/chat, closing
only fully addressed issues linked in the PR description. No session CI watch or
custom closure Action/hook/bot is needed; CI stays read-only. Failed/stale/conflicting
PRs remain open for investigation, without retries or weakened tests. Next-session
reconciliation handles failures, obsolete issue labels and Project Done; that
housekeeping is not guaranteed unattended. See the [PR delivery contract](GITHUB_WORKFLOW.md#protected-pr-delivery).
Trivial formatting-only housekeeping still uses a PR, but needs no invented issue
or Project entry. Changing an armed PR requires disabling auto-merge/removing closing
links and repeating affected validation/acceptance before rearming.

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

## Optional real-media tools

**Do not run these in CI or without the owner's explicit approval for real jobs.**
The [sample helper](../scripts/prepare-samples.ts) targets **DJI_0468.MP4 and DJI_0469.MP4
only**: pass an **explicit folder after `--`**, never rely on a personal-path default.
It reuses ready proxies but may prepare missing ones; creates only an absent v6
sample, never overwrites or migrates existing edits.

The [measurement helper](../scripts/measure-preview.ts) accepts exactly **two
1× excerpts on one enabled, opaque, zero-origin contiguous track**, no music,
extra layers, non-unit opacity or shared row points
(even neutral/Speed-only points). `PASCAP_MEASURE_URL` selects that project.
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
layered export renders premultiplied RGBA16 track groups, then merges bottom-to-top
without regrading. Serial limits: one original decoder, two intermediate readers,
one encoder and three native video children per pass. Four raw buffers (two RGB8,
two RGBA16) use **22 bytes/pixel = 182,476,800 bytes at UHD**; two 65³ Float32 LUTs
add **6,591,000 bytes**, excluding native/audio memory. Two retained clip files and
three timeline representations bound concurrency, **not disk GB**;
scratch grows with duration ([resource contract](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits)).
The static fast path requires one enabled, opaque, unanimated, zero-origin contiguous
track and opaque clips; unsupported placement/coverage uses generalized layered export, regardless
of Ripple or track ID.
Processing: [row points](LAYERS_AND_KEYFRAMES.md), [retiming/audio](SPEED_AND_AUDIO.md)
and [grading equations](COLOUR_AND_TIMING.md#colour).

## Contributor safety

- **Format before committing, not afterward.** Use each changed file's configured
  formatter and applicable import organization, save and let editor save actions
  finish, then perform final checks, review and deliberate staging. Format-on-save
  is not sufficient if the save happens after staging or commit. A later formatting
  change invalidates affected checks/staging: review it, rerun applicable checks
  and restage before commit. Check committed files for leftover formatting diffs
  afterward; preserve unrelated edits rather than forcing a clean working tree.
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
- Keep **strict schema 6**: required unique video/audio membership, all ten nullable
  channels and per-layer `ripple`, `transitions`, `openingFade`, `closingFade`.
  No project-level transitions/fades, compatibility fields/defaults/migration or
  mandatory first-track ID. Preserve incompatible v1–v5 projects/receipt snapshots
  and finished videos; registry/proxy formats remain unchanged.
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
