# Licensing and distribution

PasCap's own source and documentation are **MIT licensed**, as explicitly selected
by the maintainer. The full [project license](../LICENSE) is authoritative.
Dependencies, native tools, trademarks and user media are **not relicensed by MIT**.
This inventory is an engineering distribution contract, not legal advice or
certification of an unbuilt release/container. Seek qualified review for the
actual distribution and applicable codec-patent jurisdiction.

## What is distributed today

The Git repository contains PasCap source, tests, build instructions and the
lockfile. It does **not** contain installed npm dependencies, Node.js, Chrome,
FFmpeg/ffprobe binaries, native libraries, an OCI image or user recordings/music.
The local workflow installs npm packages and uses separately installed native
executables. No release or image is approved by adding this license.

PasCap invokes FFmpeg/ffprobe as child processes; it does not link a native FFmpeg
library into Node or the browser. That architecture is not a blanket exemption
from the obligations for **redistributing the native executables themselves**.

## npm source and built-application notices

The five direct production dependencies are:

| Package | Locked version | License |
| --- | --- | --- |
| @fastify/static | 10.1.5 | MIT |
| fastify | 5.12.5 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| zod | 4.6.5 | MIT |

The locked production closure contains **74 installations**, including nested
versions. React, React DOM, scheduler and Zod are embedded in browser chunks;
server-only dependencies are still part of a complete built-application package.
Use the actual graph, not only the direct-dependency list:

| License family | Production installations | Required treatment |
| --- | ---: | --- |
| MIT | 60 | Retain each upstream copyright and permission/disclaimer text |
| ISC | 5 | Retain each upstream copyright and permission/disclaimer text |
| BSD-3-Clause | 4 | Preserve copyright, conditions/disclaimer in source and binary documentation; do not imply endorsement |
| BlueOak-1.0.0 | 5 | Supply the license text or its permitted license link |

Non-MIT entries are fastq 1.20.3, inherits 2.0.4, semver 7.8.5,
setprototypeof 1.2.0 and split2 4.2.0 (ISC); fast-uri 3.1.8 and 4.2.1,
light-my-request 6.6.0 and secure-json-parse 4.1.0 (BSD-3-Clause); glob 13.0.6,
lru-cache 11.5.3, minimatch 10.2.6, minipass 7.1.3 and path-scurry 2.0.2
(BlueOak-1.0.0).

The browser also receives generated preload/module-interop helpers from **Vite
8.3.2** and **Rolldown 1.2.12**. These two build packages are not in the 74-entry
production closure, but their runtime code is emitted. Their MIT licenses and
full bundled third-party notices are therefore included explicitly, including
Rolldown's separate Rollup/esbuild attribution. This narrow supplement does not
claim that every development package is shipped or embedded.

`npm run licenses:check` is read-only and needs the installed locked dependencies.
The [inventory implementation](../scripts/licenses.ts) validates installed names,
versions and license declarations against the [lockfile](../package-lock.json),
rejects unreviewed license families, and reads **all shipped license/copying/notice
files**, including nested notices. It preserves upstream text, not a generic
substitute for packages declaring the same SPDX identifier. A missing dependency,
notice or mismatch fails explicitly; npm's integrity checks remain `npm ci`'s
responsibility. This is not a scanner of native libraries or a legal opinion.

abstract-logging 2.0.1 ships no license file: its published README links to the
author's MIT terms. The [explicit upstream supplement](licenses/abstract-logging-2.0.1.txt)
preserves those linked terms, attribution and retrieval provenance. This exact
version/reference is checked; a different missing license is not silently filled.

Every normal `npm run build` generates a **THIRD_PARTY_NOTICES.txt** artifact in
the built UI, after Vite creates its clean output. It includes the project MIT
text, every locked production installation's exact notices and the two reviewed
emitted-helper packages' notices. The built service
serves it at **/THIRD_PARTY_NOTICES.txt**. Keep that artifact with distributed
browser/server output and retain the license/notice files in any shipped npm
packages; do not assume minified comments or an upstream homepage suffice.
Generated notice output is not committed as a report/cache.

Development/build/test dependencies are not in this production notice closure.
If a distribution includes them (or their code is bundled), inventory and preserve
their own terms too. Node.js is a separate runtime with third-party notices;
Chrome is an externally installed test/browser tool, not a bundled PasCap component.

## Native FFmpeg and x264

[FFmpeg's licensing guidance](https://ffmpeg.org/legal.html) states that its default
license is LGPL-2.1-or-later, but enabling GPL components changes the FFmpeg build
to GPL. [x264](https://www.videolan.org/developers/x264.html) is available under
GPL-2.0-or-later (or a separately obtained commercial license); no commercial
license is assumed here. FFmpeg's
[x264 integration contract](https://ffmpeg.org/general.html#x264) requires GPL
configuration. Do not describe the current libx264-enabled toolchain as an
LGPL-only or MIT native distribution.

The [CI setup script](../scripts/ci/setup-ffmpeg.sh) builds FFmpeg/ffprobe **8.0.1**
from the official archive, SHA-256
**05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41**, with
`--disable-autodetect --enable-gpl --enable-libx264 --enable-pthreads
--disable-ffplay`, plus disabled documentation/debug output. It uses the runner's
libx264 development package. That package revision, patches and native dependency
closure are **not pinned by the FFmpeg archive checksum**. CI proves tested
correctness, not a reproducible or cleared native redistribution artifact.
Developer distro FFmpeg builds can enable many more libraries and have different
GPL versions/terms; inventory the actual binary/configuration rather than assigning
the minimal CI build's licensing to any executable named FFmpeg.

Before shipping binaries or an OCI image, the distributor must:

1. Record the exact FFmpeg/ffprobe/x264/Node/OS package versions, hashes,
   configurations, linkage, patches and included runtime dependencies. Identify
   every applicable license and preserve its copyright/license/NOTICE files.
2. Provide the **complete corresponding source matching the shipped GPL binaries**,
   including relevant changes and build/install scripts, using a legally reviewed
   GPL-compliant distribution method. A general upstream homepage or an unmatched
   source URL is not enough; a CI cache is not a source-availability commitment.
3. Retain the applicable GPL/LGPL texts and attribution, and review any additional
   libraries, base-image packages and distribution restrictions. Do not use
   `--enable-nonfree` or assume a commercial x264 license without explicit review.
4. Complete codec/patent and combined-distribution legal review for the actual
   artifact/jurisdiction. This guide does not promise patent clearance or decide
   the legal classification of every possible package arrangement.
5. Verify notice/source availability from the recipient's artifact, keep the
   application/native notices distinct and obtain explicit release approval.
   Container recipe and both-runtime acceptance remain
   [#10](https://github.com/Plonk42/PasCap/issues/10) and
   [#11](https://github.com/Plonk42/PasCap/issues/11), not completed here.

## Media, assets and publication safety

The software license does not grant rights to original recordings, music, fonts,
logos or third-party product assets. No CapCut assets/source, licensed sample music
or owner footage is included in the repository or notice artifact. Generated
proxies, caches, reports, project snapshots and private paths stay out of source
publication. Synthetic fixtures do not license any owner's real inputs.
Keep sources external/read-only in any future package and review the exact
distribution contents before publishing. See [deployment](DEPLOYMENT.md) and
[contributor safety](DEVELOPMENT.md#contributor-safety).
