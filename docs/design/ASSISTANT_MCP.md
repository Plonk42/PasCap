# Assistant rough cut through MCP

**Status: design and delivery plan; Phases 1 and 2 are implemented.** Nothing else below
is a current contract; the guides it links describe today's behaviour. The owner approved
Phase 0 on 2026-10-21 (see [decisions](#decisions-to-confirm)); later phases, routes, tool
names and constants remain proposals to confirm, amend or reject before work starts.

## Goal

The user imports the flight's recordings, makes a first pass (removing whole recordings
from the project and keeping only the interesting parts of the others), chooses a music
recording, then **hands the project off** to an LLM. Through an MCP server the LLM:

1. picks the footage parts worth using, inside what the user kept: it may remove more,
   never add back what the user eliminated;
2. places them on one or more video tracks in a coherent order;
3. sets transitions and fades;
4. grades each track and tunes each clip's Sharpen/Clarity/Denoise, with Auto adjust or
   individual settings;
5. **aligns cuts and transitions with the music**, which needs a new music analysis in
   the service;
6. finishes with a complete project the user reviews and edits in the editor before
   exporting.

While working, the LLM checks its result through stills and contact sheets rendered by
the service from the same compositor as export, plus text summaries of the timeline.

Non-goals: the assistant never imports, relinks, prepares, exports or deletes anything;
it never touches originals; it does not drive the editor's UI; it produces no new
rendering path, schema-less data or defaults. Export, project deletion and real-media
jobs stay with the user.

## What exists today

The plan builds on current code; these are the pieces it reuses or must change.

| Area                         | Today                                                                                                                                                                                                                                                                                                 | Consequence for the plan                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project document             | Strict Zod schema ([model](../../src/shared/model.ts)); one JSON per project; `PUT /api/projects/:id` with `expectedRevision`, 409 on a stale revision ([storage](../../src/server/storage.ts)); `assertProjectSources` checks registered recordings and ranges                                       | The assistant writes through the same validated save; a concurrent editor tab must stop saving while it works                                                                        |
| Edits                        | One pure reducer, `applyCommand(document, command)` over the `EditCommand` union ([commands](../../src/shared/commands.ts)): insert/delete/trim/split/place/transition/fades/colour/speed/reverse/transform/detail/music/opacity/keyframes/tracks/bookmarks                                           | Every assistant edit is an existing command; no second edit vocabulary                                                                                                               |
| Layout                       | `calculateLayout()` and `sampleTimeline(project, frame)` ([timeline](../../src/shared/timeline.ts)) give placed clips, transitions and the per-frame `PreviewLayer` list                                                                                                                              | Text summaries and stills come from the authoritative layout                                                                                                                         |
| Native compositor            | `composeLayerFrame()` ([layered-frame](../../src/server/layered-frame.ts)) composes one project frame from per-source RGB8 content into premultiplied RGBA16, CPU pool of ≤ 8 workers; it is the export parity reference                                                                              | Stills reuse it unchanged                                                                                                                                                            |
| Recordings                   | Registry v2 ([media](../../src/shared/media.ts)): metadata, verified 720p proxy (`h264-720p-bt709-gop15-v1`, closed GOP 15), five thumbnails, `damage` ranges; project bin `media.videoIds`/`audioIds`                                                                                                | The assistant works only on prepared recordings in the bin                                                                                                                           |
| Camera motion                | Background job `motion` writes `motion-v3.json` (per-frame `tx/ty/zoom/rotation`, DJI telemetry); `motionProfile()` and `smoothRanges()` ([motion-analysis](../../src/shared/motion-analysis.ts)); `GET /api/media/:id/motion`                                                                        | Shot descriptors and steady ranges derive from it, no new decode                                                                                                                     |
| Music                        | `AudioLibrary` ([audio](../../src/server/audio.ts)) prepares a PCM16 48 kHz stereo cache (`pcm16-48k-stereo-mono-unity-v3`) and a ≤ 2,048-peak waveform; no tempo, beat or structure analysis                                                                                                         | **New music analysis job** reading that cache                                                                                                                                        |
| Auto adjust / AWB            | Pure estimators on RGBA bytes: `analyseAutoAdjust(frames)` ([auto-adjust](../../src/shared/auto-adjust.ts)), `frameIlluminant`/`poolWhiteBalance` ([white-balance](../../src/shared/white-balance.ts)); the editor samples frames with WebCodecs in the browser                                       | The service can run the same estimators on FFmpeg-decoded proxy frames                                                                                                               |
| Detail                       | Static clip `detail` with no estimator ([detail filters](DETAIL_FILTERS.md))                                                                                                                                                                                                                          | A noise/sharpness measurement helper is new                                                                                                                                          |
| First-pass selection         | Whole recordings leave the project with **Remove from project**; the Source preview's applied IN/OUT was **browser-local** (`pascap-media-ranges-<project>` in `localStorage`, one range per recording); it is now the recording's first kept range in the project's `selects`, copied into new clips | The user's kept ranges are invisible to the service: they must move into the project document                                                                                        |
| Jobs                         | `JobQueue` runs one heavy task at a time, `motion` in the background after other jobs ([jobs](../../src/server/jobs.ts), [media](../../src/shared/media.ts))                                                                                                                                          | Music analysis is another background kind; stills are not jobs                                                                                                                       |
| Service guards               | Loopback Fastify; every request needs an allowed Host/Origin and non-GET requests the `x-pascap-client` header ([app](../../src/server/app.ts)); 1 MiB body limit                                                                                                                                     | An MCP endpoint joins this API behind the same loopback checks, with its own token                                                                                                   |
| Request and response schemas | Every request body/params is a Zod schema in [app.ts](../../src/server/app.ts); the web client validates every response with Zod ([api.ts](../../src/web/api.ts)); but `EditCommand` is a plain TypeScript union, not a schema, and each route/client wrapper is written by hand                      | A single operation registry can generate the HTTP route, the MCP tool and the typed client from one definition; the edit vocabulary must become a schema to be exposed automatically |
| Dependencies                 | `fastify`, `@fastify/static`, `react`, `react-dom`, `zod` 4.6 ([package.json](../../package.json)), which has `.meta()` and `z.toJSONSchema()`; locked production-license inventory                                                                                                                   | Adding `@modelcontextprotocol/sdk` is a dependency change: risky route, licence inventory update, zod 4 compatibility check                                                          |

## Decisions to confirm

Confirmed by the owner on 2026-10-21: the operation registry, existing REST routes migrating
when touched or on demand, VS Code as the first MCP client, music analysis shipping first
(done), the MCP endpoint inside the service, the same project with a lease and checkpoints
(checkpoints serve the user on large projects too), an image budget set in the service
configuration with conservative defaults, and no brief permissions: security is not a
concern for now and the assistant may use every editing operation. Import, preparation,
export and deletion stay out of the assistant's scope for now (a scope choice, not a
permission). The work iterates on the `mcp` branch until the owner merges it.

| Question                           | Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How service features reach the MCP | One **operation registry** in the service: each capability is defined once (name, LLM-facing description, Zod input/output with `.meta()`, access, audience, `run`). Three surfaces are generated from it in a loop each: the HTTP route `POST /api/ops/<name>`, the MCP tool and the typed web client. Adding a feature is adding one operation file; nothing is written twice.                                                                                                                                         | The MCP must not be a second API to maintain. Zod schemas are the TypeScript equivalent of annotations: they already validate every request, and zod 4 converts them to the JSON Schema an MCP tool needs. TypeScript has no classpath scanning, so a registry array (tested for completeness) replaces decorator discovery.                                                                                                                                           |
| How the edit vocabulary is exposed | `EditCommand` becomes `editCommandSchema`, a Zod discriminated union with a description per variant and field; the type is `z.infer` of it (a type-equality test guards the migration). One `edit` operation takes a batch of commands.                                                                                                                                                                                                                                                                                  | Every command added for the editor is then available to the assistant automatically, with its description, validation and error messages, and no wrapper tools are needed.                                                                                                                                                                                                                                                                                             |
| Where the MCP server runs          | **In the service**: a Streamable HTTP endpoint at `/mcp` on the existing loopback port, registered from the same registry, calling `op.run` directly. Access needs a token the service generates at startup (`<dataDir>/mcp-token`, shown in the Hand off dialog's configuration snippet) in place of the `x-pascap-client` header; Host/loopback checks stay. No separate process, no second backend.                                                                                                                   | The service already owns the lease, the compositor pool, the job queue and the data directory, so in-process tools need no HTTP hop, token hand-over, body limit or request timeout, and can push progress later. Nothing new is published: the endpoint lives on the loopback port the editor already uses. VS Code, Claude Code and Codex connect to HTTP servers with a header; a stdio-only client uses the generic `mcp-remote` bridge, which is not PasCap code. |
| Where the user's kept ranges live  | New required project field **`selects`**: per recording in the bin, an ordered list of kept source ranges. No entry = the whole recording is available; `[]` is not allowed (remove the recording instead). Schema bump with migration (`selects: {}`) and frozen fixture per [data compatibility](../GITHUB_WORKFLOW.md#data-compatibility).                                                                                                                                                                            | The assistant cannot read `localStorage`, and the rule "never add back" needs a server-checkable source of truth. The Source preview's applied range becomes a view of the first select, so the UI change is small.                                                                                                                                                                                                                                                    |
| How the assistant edits            | The `edit` operation `{ commands, expectedRevision }`: the service applies the batch atomically with `applyCommand`, validates like a save and writes one revision. Candidates (`preview_edits`, `still` of a draft) are also `commands` relative to a saved revision, never whole documents. The editor keeps its document saves.                                                                                                                                                                                       | One validation path and one revision per logical step (the assistant's "one Undo step"); rich command errors come back verbatim; commands stay small under the 1 MiB body limit where a large project document would not; the editor can adopt it later for bulk actions.                                                                                                                                                                                              |
| Concurrency with the open editor   | A server-side **assistant session** (lease) per project: started from the editor's **Hand off** dialog after flushing autosave, with a **checkpoint** copy of the document. While it holds the lease, editor saves get 423 and the editor follows the document read-only (polling revision); `edit` requires the lease. The user can **Take over** at any time; the LLM can end the session with notes (`session_end`). By default the lease never expires (owner, 2026-10-21); a service setting can end idle sessions. | Same project, no silent divergence, nothing destructive: the checkpoint restores the pre-hand-off cut through **Open project file…** (new project) or a **Restore checkpoint** action. A `copy: true` option builds the cut in a new project instead, using the existing import path.                                                                                                                                                                                  |
| How the LLM sees pictures          | **Native stills** from the proxies through `composeLayerFrame`, encoded to JPEG by FFmpeg, served by new routes; contact sheets tile several stills with a JSON legend. No browser screenshots.                                                                                                                                                                                                                                                                                                                          | The composed picture is what matters, it matches export, and it needs no GPU or Chrome. The editor UI is for the user.                                                                                                                                                                                                                                                                                                                                                 |
| Music analysis                     | A new background job kind (`music-analysis`) on the existing PCM cache: onset envelope, tempo, beats, downbeats, loudness, sections and accents, cached as `music-v3.json`; pure TypeScript in a worker thread, no new dependency or decoder.                                                                                                                                                                                                                                                                            | The PCM is already exact 48 kHz stereo; a bounded single-thread analysis takes about a second per song. It also gives the editor beat ticks, **Snap to beats** and the music's structure without the assistant.                                                                                                                                                                                                                                                        |
| Export                             | Not exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The user reviews first; export remains a deliberate action with its own storage checks.                                                                                                                                                                                                                                                                                                                                                                                |

## Architecture

```mermaid
flowchart LR
  L[LLM client] -- MCP Streamable HTTP\n/mcp + token --> X
  subgraph Service :4318
    O[Operation registry\nsrc/server/operations/*]
    O -- loop --> H[Fastify routes\n/api/ops/:name]
    O -- loop --> X[MCP tools and resources\n/mcp]
    O -- types --> W[Web client ops.name]
    H --> K
    X --> K[op.run]
    K --> P[(projects/*.json\nrevision, checkpoints, session)]
    K --> R[(registries, proxies,\nmotion-v3.json, PCM, music-v3.json)]
    K --> C[Native compositor\ncomposeLayerFrame]
    K --> J[JobQueue\nmusic-analysis, motion]
    K --> F[FFmpeg\nproxy frame decode, JPEG]
  end
  E[Editor tab] -- Hand off / Take over\nfollow revision --> H
```

The registry is the only place a capability is described; the HTTP routes serve the
editor, the MCP endpoint serves the LLM, and both call the same `run`. The MCP layer adds
only what the protocol needs: JSON Schema from the Zod input, image content for stills,
timecode beside frames, and the service's validation messages as tool errors.

## Data model changes

### Project `selects` (schema bump)

```ts
selects: Record<mediaId, SelectRange[]>; // SelectRange = { sourceIn, sourceOut }, OUT exclusive
```

- Keys must be in `media.videoIds`; ranges are within the registered frame count, unique,
  ascending, non-overlapping, at least one frame; no empty arrays.
- Removing a recording from the project removes its entry; a clip may use frames outside
  the selects (the user can always do what they want in the editor). Only **assistant
  sessions** are bound: every clip they insert, trim or place must lie inside one select
  of its recording, and a `selects` change they make must be a subset of the previous one
  (`narrow` only). The service enforces this in `edit` during a session.
- Migration: add `selects: {}`. The Source preview keeps its applied IN/OUT; applying a
  range writes it as the recording's single select (one Undo step through a new
  `select-set` command); a later **Keep this range too** adds a second one. Clips still copy
  the applied range as before.

### Assistant session and checkpoint (service files, not schema)

Implemented on the `mcp` branch ([#235](https://github.com/Plonk42/PasCap/issues/235),
[sessions](../../src/server/sessions.ts)). `<dataDir>/assistant/<id>/session.json` holds the
project's latest session: `{ projectId, startedAt, startedBy, lastActivityAt, brief,
checkpointId, edits, endedAt, endedBy, notes }`; `<dataDir>/assistant/<id>/checkpoints/` holds
checkpoints `{ summary, document }`, the last `PASCAP_ASSISTANT_CHECKPOINTS` (5) per project,
never removing the active session's own. Neither is part of the project document, export
receipts or compatibility rules; a checkpoint is upgraded and validated like a project file
when restored.

`session_start` (the editor, or the assistant itself from what the user asked, decided on
2026-10-21) checks the revision the starter read (unprepared recordings in the bin do not block
it: describe_project marks them, and stills cannot show them),
checkpoints the project and takes its write lease. While it is active every write of the user
(editor saves, renames, deletes, imports into the bin, `edit` from the editor) is refused with
423, and the assistant's writes are allowed; without an active session the assistant cannot
write and is told why (none started, the user took the project back, or the lease expired).
A session lasts until the user takes over or the assistant calls `session_end` (owner,
2026-10-21: an idle assistant may still be thinking or waiting for the user's reply);
`PASCAP_ASSISTANT_LEASE_MINUTES` (0 by default, meaning never) can instead end a session after
that many minutes without any assistant call naming
the project. During a session `edit` and `preview_edits` also refuse, leaving the project
unchanged, any batch that widens kept ranges or inserts or changes a clip outside its
recording's kept ranges or bin; the user's own clips outside them may stay. `session_end` is
Take over from the editor, or the assistant finishing with notes; `checkpoint_restore` replaces
the project with a checkpoint in one revision after checkpointing its current state. The
checks run inside the project store's write queue, so no save interleaves with a start or a
restore.

The **brief** is what the user tells the assistant, in the chat or later in the Hand off
dialog: notes (≤ 2,000 characters), music track, target length in seconds, allowed camera
movement (0.5–6) and the maximum number of clips, all optional. It carries no permissions:
the assistant may use every operation. It is stored and returned, never interpreted by the
service.

### Music analysis cache

`audio-assets/<id>/pcm16-48k-stereo-mono-unity-v3/music-v3.json`, tied to the PCM cache
(stored alongside it; removed with it; ignored if the asset's `content` changed):

```ts
{
  version: 3,
  sampleRate: 48000, hop: 480,             // 10 ms feature rate
  tempo: { bpm, confidence },              // global; curve: [{ fromSample, bpm }]
  meter: { beatsPerBar: 3 | 4, confidence },
  beats: [{ sample, strength, downbeat }], // ascending samples
  accents: [{ sample, strength }],         // strong isolated onsets
  loudness: number[],                      // dBFS per 100 ms
  tone: [low, mid, high][],                // dBFS per second: < 250 Hz, 250 Hz–4 kHz, > 4 kHz
  key: { tonic, mode, confidence } | null, // 'C'…'B', 'major' | 'minor'
  swells: [{ fromSample, toSample, kind: 'crescendo' | 'decrescendo', changeDb, sudden }],
  silences: [{ fromSample, toSample }],
  sections: [{ fromSample, toSample, kind: 'quiet' | 'build' | 'peak' | 'release', loudnessDb }]
}
```

Positions are PCM samples; the service converts to music-source frames and project frames
when asked (project frame = `start + (sourceFrame − sourceIn)`, through loops; see
`musicSourceFrame` in [audio](../../src/shared/audio.ts)). Arrays are bounded by song
length: a 10-minute song has about 1,500 beats and 6,000 loudness values.

## The operation registry

Every capability is one definition in `src/shared/operations/` (pure Zod, so the web
client can validate responses with it) and its `run` in `src/server/operations/`:

```ts
export interface OperationSpec<N, I, O> {
  name: N; // unique snake_case; the tool name and the route segment
  description: string; // written for the LLM: when to use it, what it returns
  input: I; // a Zod object whose fields carry .meta({ description })
  output: O; // a Zod schema; later also images (bytes plus a JSON legend)
  access: 'read' | 'write'; // write bumps the revision (and later needs the session lease)
  audience: readonly ('editor' | 'assistant')[]; // required, no default
}
// src/server/operations/index.ts
export const runners: { [N in OperationName]: (context, input) => Promise<output> };
```

`src/shared/operations/index.ts` exports the `operations` array; a definition that is not
in the array does not exist, and an operation without a runner fails type checking.
From that array:

- **HTTP**: one loop registers `POST /api/ops/<name>` per operation (parse `input`, call
  `run`, check and send `output`) behind the existing loopback and client guards; the
  existing REST routes stay as they are and migrate one at a time when touched or when
  an operation needs them.
- **MCP**: one loop registers one tool per operation whose `audience` includes
  `assistant`, with `z.toJSONSchema(op.input)` and `op.description`; image outputs
  become MCP image content plus the legend as text.
- **Web client**: `callOperation(name, input)` ([operations](../../src/web/operations.ts)),
  typed from the array and validating the response with the operation's output schema,
  so the editor can use new operations (bulk actions, beats to bookmarks) without a
  wrapper in `api.ts`.
- **Docs**: `npm run operations:catalogue` writes the [catalogue](#operation-catalogue)
  below from the array; a unit test, and so `npm run check`, fails when it drifts.

Drift gates, as unit tests over the array: unique snake_case names; non-empty
descriptions; every input and output converts to JSON Schema; every input field is
described; `audience` set explicitly; one runner per operation. A contract test runs the
operations through their HTTP routes on a disposable service; Phase 5 adds the same
fixture through an in-memory MCP client against the in-process endpoint.

What stays manual: the playbook (when to use what), noted descriptions where a
`.refine()` rule cannot appear in JSON Schema (clip `sourceOut > sourceIn`, the layout
refinement), and the `audience` decision for each operation. Decorators would add nothing:
they still need the module imported to register, and the schema would be harder to read
and test.

### `editCommandSchema`

`EditCommand` ([commands](../../src/shared/commands.ts)) is `z.infer` of
`editCommandSchema` ([command schema](../../src/shared/command-schema.ts)), a Zod
discriminated union on `type`, each variant and field with a `.meta({ description })`
written for the LLM. A compile-time equality test keeps it identical to the former
hand-written union, and `applyCommand` is unchanged. The `edit` operation's input is
`{ projectId, expectedRevision, commands: editCommandSchema.array().max(64) }`. Any command
added later for the editor is exposed to the assistant the moment it is in the union.

Four commands change one appearance setting of a track and keep every other saved value, so the
assistant never resends a whole Colour or Transform
([#252](https://github.com/Plonk42/PasCap/issues/252)): `colour-setting` (one of the fourteen
scalar Colour settings), `hsl-band` (one HSL range), `colour-curve` (one curve) and
`transform-setting` (one Transform base setting). A setting with keyframes follows them, so
setting its base is rejected with the keyframe count; the assistant changes the keyframes with
`layer-key-value` instead. The editor keeps sending whole `colour` and `transform` commands.

The editor's `layer-add` and `layer-update` carry a complete track (every Colour and Transform
setting and keyframe): half of the command schema. `edit` offers the assistant
`assistantEditCommandSchema`, every command except those two, with `layer-create` (a neutral track
with an ID and a name) and `layer-options` (name, visibility or Ripple; turning Ripple on packs the
clips like the editor's toggle) in their place; the assistant then sets the track's appearance
setting by setting.

Only `edit` publishes the command schema (about 50 KB of JSON Schema). `preview_edits`,
`still` and `timeline_sheet` take the same commands but publish them as `referencedEditCommandSchema`:
a command `type` plus its fields, validated exactly like `edit`'s. Each embedded the whole schema
before, so the tool list a client loads for every conversation was 413 KB; it is now about
74 KB ([#243](https://github.com/Plonk42/PasCap/issues/243)).

### Operation catalogue

<!-- operation-catalogue:start -->

<!-- Generated from src/shared/operations by `npm run operations:catalogue`; edit the definitions, not this text. -->

#### `list_projects`

Read; for editor and assistant. List the saved projects, most recently saved first, with their title, revision, number of clips and duration. Use it to find the ID of the project the user means; ask when several could match. A project that cannot be opened carries the reason.

| Input | Type | Description |
| ----- | ---- | ----------- |

#### `describe_project`

Read; for editor and assistant. Summarise a saved project: its revision, duration, video tracks with their clips in timeline order (project frames and timecodes, source ranges, speed, direction), transitions, music tracks, the recordings with the ranges the user kept, and bookmarks. Frames are integers at 30000/1001 fps. Read it before editing and after each edit batch.

| Input       | Type   | Description              |
| ----------- | ------ | ------------------------ |
| `projectId` | string | ID of the saved project. |

#### `describe_track`

Read; for editor and assistant. Read every appearance value of one video track: its saved Colour (scalar settings, HSL ranges, curves), Opacity, Transform and keyframes, which settings follow keyframes, and the values that apply at the requested project frames. Settings interact (Contrast with Shadows, Highlights, Whites and Blacks shape one tone curve), so read the whole track before grading it.

| Input       | Type             | Description                                                                          |
| ----------- | ---------------- | ------------------------------------------------------------------------------------ |
| `projectId` | string           | ID of the saved project.                                                             |
| `layerId`   | string           | ID of the video track.                                                               |
| `frames`    | array of integer | Up to 32 project frames at which to report the values that apply; none when omitted. |

#### `describe_recording`

Read; for editor and assistant. Map where a video recording is usable and how its camera moves, measured from its camera motion analysis and the drone's flight data, inside the ranges the user kept: its steady ranges with their length, picture movement (% of the image width per second), roughness, a camera move name (static, pan, tilt, push in, pull out, rotate; a sideways flight looks like a pan) and mean flight data, plus damaged frames and how much of it hovers still. It never says what the footage shows: with sheet true, it also returns a contact sheet with the middle frame of each steady range (the longest ones when they do not all fit), for you to judge. To compare several recordings, compare_recordings shows them in one picture; recording_sheet shows any other frames.

| Input             | Type    | Description                                                                                                                                   |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`       | string  | ID of the saved project, whose kept ranges and session brief apply.                                                                           |
| `mediaId`         | string  | ID of a video recording in the project, from describe_project.                                                                                |
| `allowedMovement` | number  | How much the movement may change in a steady range (0.5–6, lower is steadier), as in Source preview; defaults to the session brief's, else 2. |
| `sheet`           | boolean | True adds a contact sheet of the middle frames of the steady ranges.                                                                          |

#### `music_analysis`

Read; for editor and assistant. Read the music of the project's music clips at project frames (where each plays on the timeline, repeated across loops): tempo, meter, beats, downbeats, accents (strong hits worth cutting on), key and mode, sections (quiet, build, peak, release) with their loudness and tone (low, mid and high frequency levels), swells (crescendos and decrescendos, sudden or gradual) and silences. Use a frame window for long music. A clip whose music is not analysed yet says so; ask the user to analyse it in Audio → Music.

| Input         | Type    | Description                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------ |
| `projectId`   | string  | ID of the saved project.                                                                   |
| `musicClipId` | string  | ID of one music clip, from describe_project; every music clip of the project when omitted. |
| `fromFrame`   | integer | First project frame of the window.                                                         |
| `toFrame`     | integer | Project frame after the window (exclusive).                                                |

#### `check_alignment`

Read; for editor and assistant. Measure how the cut follows the music: for every boundary of every video track (or one), the frame the viewer perceives as the change (the cut, the middle of a dissolve, the middle of a black pause), its nearest beat and downbeat and the signed offsets in frames, and a summary. Within one frame of a beat counts as on the beat.

| Input         | Type   | Description                                                                                |
| ------------- | ------ | ------------------------------------------------------------------------------------------ |
| `projectId`   | string | ID of the saved project.                                                                   |
| `layerId`     | string | One video track only.                                                                      |
| `musicClipId` | string | ID of one music clip, from describe_project; every music clip of the project when omitted. |

#### `snap_cuts_to_beats`

Write; for editor and assistant. Move the boundaries of one Ripple video track onto the music: left to right, trim each boundary's left clip so the change lands on the nearest beat (or downbeat), shortening it, or lengthening it where its recording has footage inside the kept ranges, else taking the nearest beat on the other side; each clip stays at least minimumSeconds long and transitions keep their durations; later clips follow. Returns the proposed trim commands and each boundary before and after; with apply, saves them as one edit (needs the session and expectedRevision). Do the arithmetic with this rather than by hand.

| Input              | Type                 | Description                                                                                |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| `projectId`        | string               | ID of the saved project.                                                                   |
| `layerId`          | string               | ID of a video track with Ripple on.                                                        |
| `prefer`           | "beat" or "downbeat" | Snap to every beat or to downbeats only.                                                   |
| `minimumSeconds`   | number               | Shortest a clip may become; a boundary that would need a shorter clip stays where it is.   |
| `musicClipId`      | string               | ID of one music clip, from describe_project; every music clip of the project when omitted. |
| `apply`            | boolean              | True saves the trims as one edit; false only proposes them.                                |
| `expectedRevision` | integer              | Revision you last read, from describe_project; required with apply.                        |

#### `session_start`

Write; for editor and assistant. Take the project's write lease for an assistant session, after checkpointing it, so the editor follows your edits read-only until the user takes over or you call session_end. Required before edit, checkpoint_restore or any write. Pass the user's brief from the conversation. Refused while another session is active or when the revision is stale. The session lasts until the user takes over or you call session_end, unless the service ends idle sessions (expiresAt).

| Input              | Type    | Description                                                      |
| ------------------ | ------- | ---------------------------------------------------------------- |
| `projectId`        | string  | ID of the saved project.                                         |
| `expectedRevision` | integer | Revision you last read, from describe_project.                   |
| `brief`            | object  | The user's brief, from what they asked; every field is optional. |

#### `session_status`

Read; for editor and assistant. Read the project's latest assistant session (null if none): whether it is active, its brief, its edit log and the notes it ended with, the project's saved revision and its checkpoints, newest first.

| Input         | Type    | Description                           |
| ------------- | ------- | ------------------------------------- |
| `projectId`   | string  | ID of the saved project.              |
| `checkpoints` | boolean | False leaves out the checkpoint list. |

#### `session_end`

Write; for editor and assistant. End the active assistant session and give the project back to the user, with notes: what you built, the choices you made and anything the user should look at. From the editor it is the Take over action.

| Input       | Type           | Description              |
| ----------- | -------------- | ------------------------ |
| `projectId` | string         | ID of the saved project. |
| `notes`     | string or null | Notes for the user.      |

#### `edit`

Write; for editor and assistant. Apply up to 64 edit commands to a saved project, in order, as one step: either every command applies and the project is saved once with the next revision, or nothing changes and the first rejected command's reason is returned. A stale expectedRevision is rejected; read the project again first.

| Input              | Type            | Description                                                          |
| ------------------ | --------------- | -------------------------------------------------------------------- |
| `projectId`        | string          | ID of the saved project.                                             |
| `expectedRevision` | integer         | Revision the commands were written against, from describe_project.   |
| `commands`         | array of object | Commands applied in order; each sees the result of the previous one. |

#### `preview_edits`

Read; for editor and assistant. Try up to 64 edit commands against the saved project without saving: the same checks as edit, including the session rules, and the resulting duration and clip count, or the first rejected command's reason.

| Input       | Type            | Description                |
| ----------- | --------------- | -------------------------- |
| `projectId` | string          | ID of the saved project.   |
| `commands`  | array of object | Commands applied in order. |

#### `checkpoint`

Write; for editor and assistant. Keep a copy of the project as it is saved now, to restore later with checkpoint_restore; only the most recent checkpoints of a project are kept.

| Input       | Type           | Description              |
| ----------- | -------------- | ------------------------ |
| `projectId` | string         | ID of the saved project. |
| `label`     | string or null | Short name for it.       |

#### `checkpoint_restore`

Write; for editor and assistant. Replace the project with one of its checkpoints, as one new revision; the current state is checkpointed first, so it can be restored in turn.

| Input              | Type    | Description                                    |
| ------------------ | ------- | ---------------------------------------------- |
| `projectId`        | string  | ID of the saved project.                       |
| `expectedRevision` | integer | Revision you last read, from describe_project. |
| `checkpointId`     | string  | ID from session_status.                        |

#### `checkpoint_copy`

Write; for editor. Save one of the project's checkpoints as a new project with its own ID, leaving the project unchanged; returns the new project.

| Input          | Type   | Description               |
| -------------- | ------ | ------------------------- |
| `projectId`    | string | ID of the saved project.  |
| `checkpointId` | string | ID from session_status.   |
| `title`        | string | Title of the new project. |

#### `hand_off_readiness`

Read; for editor. What an assistant can use in a project: each video recording of its bin with its proxy and camera motion analysis, each music recording with its playback cache and tempo analysis, whether an export is running (stills wait for it), and how an MCP client connects.

| Input       | Type   | Description              |
| ----------- | ------ | ------------------------ |
| `projectId` | string | ID of the saved project. |

#### `music_waveform`

Read; for editor. The level of a prepared music recording for drawing its waveform in the editor: the lowest and highest sample of either channel for every 10 ms of its playback cache, read from a saved cache or drawn from the cache once.

| Input     | Type   | Description                       |
| --------- | ------ | --------------------------------- |
| `mediaId` | string | ID of a prepared music recording. |

#### `still`

Read; for editor and assistant. Render one project frame as the export composes it (every enabled track with its Colour, Detail, Transform, Opacity and transitions), from the 720p editing proxies, as a JPEG. Use crop for a 1:1 detail of the 1280 × 720 composition, for example to judge Sharpen or Denoise. Width and crop size are limited by the service's image budget.

| Input       | Type            | Description                                                                                                             |
| ----------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `projectId` | string          | ID of the saved project.                                                                                                |
| `frame`     | integer         | Project frame to render.                                                                                                |
| `width`     | integer         | Picture width in pixels; defaults to, and may not exceed, the service's still width.                                    |
| `crop`      | object          | Render this region at 1:1 instead of the scaled whole frame.                                                            |
| `commands`  | array of object | Edit commands applied in memory to the saved project before rendering, to compare a candidate change without saving it. |

#### `timeline_sheet`

Read; for editor and assistant. Render several project frames as one contact sheet, row by row, with a legend naming each cell's frame, timecode and clips. Cheaper than several stills for checking pacing, shot order or a grade across the cut. The number of frames and the cell width are limited by the service's image budget.

| Input       | Type             | Description                                                                                                             |
| ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `projectId` | string           | ID of the saved project.                                                                                                |
| `frames`    | array of integer | Project frames in the order to show them.                                                                               |
| `commands`  | array of object  | Edit commands applied in memory to the saved project before rendering, to compare a candidate change without saving it. |

#### `recording_sheet`

Read; for editor and assistant. Render source frames of one video recording's editing proxy as a contact sheet, without any track Colour or Transform, to choose footage before placing it. A single frame renders at the still width.

| Input     | Type             | Description                                               |
| --------- | ---------------- | --------------------------------------------------------- |
| `mediaId` | string           | ID of a prepared video recording.                         |
| `frames`  | array of integer | Source frames of the recording in the order to show them. |

#### `compare_recordings`

Read; for assistant. Show candidate shots from several video recordings in one contact sheet, without track Colour or Transform, to pick the best of similar takes before placing it. Each candidate takes `frames` cells in a row, spread across its range (frames 1 lays the candidates out row by row). A candidate without a range shows its recording's longest steady range inside the kept ranges at the session's allowed movement, as describe_recording lists them, else its first kept range or the whole recording. The number of cells is limited by the service's image budget.

| Input        | Type            | Description                                                                                                                                  |
| ------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`  | string          | ID of the saved project.                                                                                                                     |
| `candidates` | array of object | Candidates in the order to show them; a recording may appear more than once with different ranges.                                           |
| `frames`     | integer         | Cells per candidate, the centres of equal parts of its range; defaults to 1, its middle. 3 shows how its movement starts, develops and ends. |

#### `estimate`

Read; for editor and assistant. Measure footage the way the editor's automatic tools do, from proxy frames, and return the values with the edit commands that apply them (pass them to edit; nothing changes until then). kind auto-adjust is Track → Colour → Auto: eleven Colour settings balancing exposure, contrast, white balance and colour. white-balance is Auto white balance: Temperature and Tint. detail measures noise and softness and suggests the clip's Denoise and Sharpen (never Clarity, a look). Analyse a clip (clipId: the whole clip, or with frame the second around that project frame, as at the playhead), a whole track (layerId: all its clips by duration; not for detail) or a recording range (mediaId, sourceIn, sourceOut: values only, no commands). Judge the result with a still.

| Input       | Type                                         | Description                                                                                                                                                |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId` | string                                       | ID of the saved project.                                                                                                                                   |
| `kind`      | "auto-adjust" or "white-balance" or "detail" | What to estimate.                                                                                                                                          |
| `clipId`    | string                                       | Analyse this clip.                                                                                                                                         |
| `frame`     | integer                                      | With clipId: analyse the project frames within 1 s of this one, inside the clip, instead of the whole clip.                                                |
| `layerId`   | string                                       | Analyse every clip of this video track instead.                                                                                                            |
| `mediaId`   | string                                       | Analyse a range of this video recording instead, with sourceIn and sourceOut.                                                                              |
| `sourceIn`  | integer                                      | First source frame of the recording range.                                                                                                                 |
| `sourceOut` | integer                                      | Source frame after the recording range (exclusive).                                                                                                        |
| `applyAs`   | "values" or "keyframe"                       | Colour kinds: values replaces the track's values (leaving animated settings unchanged); keyframe keys the settings at frame, which needs clipId and frame. |
| `intensity` | number                                       | auto-adjust: strength of the correction in %; 80 is the correction as fitted, 100 exaggerates it by a quarter.                                             |

#### Edit commands

The `commands` of `edit`; their fields are described in the JSON Schema of the tool.

| Command               | Fields                                         | Description                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insert`              | `clip`, `index`                                | Insert a new video clip into the project clip array. A Ripple track plays its clips in array order, packed from its first clip; a track without Ripple places it at clip.start, and it must not overlap another clip.                                                                                     |
| `delete`              | `clipId`                                       | Remove a clip. A Ripple track closes the gap; on a track without Ripple the other clips keep their starts.                                                                                                                                                                                                |
| `reorder`             | `clipIds`                                      | Reorder the whole project clip array; Ripple tracks play their clips in this order. Transitions between clips that are no longer adjacent become cuts.                                                                                                                                                    |
| `trim`                | `clipId`, `sourceIn`, `sourceOut`              | Change a clip's source range. Its start stays; a Ripple track re-sequences the clips after it. Transitions or fades that no longer fit reject the edit.                                                                                                                                                   |
| `trim-place`          | `clipId`, `sourceIn`, `sourceOut`, `start`     | Change a clip's source range and start together, like a left-edge trim. On a Ripple track only the first clip's start can change; later starts follow the sequence.                                                                                                                                       |
| `split`               | `clipId`, `sourceFrame`, `newClipId`           | Split a clip into two clips with independent settings, joined by a cut; the second clip on the timeline gets newClipId. A reversed clip keeps its higher source frames first.                                                                                                                             |
| `remove-source-range` | `clipId`, `sourceIn`, `sourceOut`, `newClipId` | Cut source frames [sourceIn, sourceOut) out of a clip. Removing the middle leaves two clips; removing an end trims the clip; removing everything deletes it. A Ripple track closes the gap; otherwise the remaining pieces keep their timeline positions. The range must lie within the clip's own range. |
| `duplicate`           | `clipId`, `newClipId`                          | Copy a clip (range, speed, direction and detail) right after it. A Ripple track inserts the copy into its sequence; otherwise it starts at the original's end and must not overlap another clip.                                                                                                          |
| `colour`              | `layerId`, `colour`                            | Replace a video track's complete Colour; it applies to every clip on the track. Settings with track keyframes follow their keyframes instead of these base values.                                                                                                                                        |
| `colour-setting`      | `layerId`, `setting`, `value`                  | Set one scalar Colour setting of a video track, keeping every other one. Rejected while the setting has track keyframes, which it then follows: change those with layer-key-value.                                                                                                                        |
| `hsl-band`            | `layerId`, `band`, `values`                    | Set one HSL range of a video track's Colour, keeping the other ranges and settings.                                                                                                                                                                                                                       |
| `colour-curve`        | `layerId`, `channel`, `points`                 | Replace one curve of a video track's Colour, keeping the other curves and settings.                                                                                                                                                                                                                       |
| `transform-setting`   | `layerId`, `setting`, `value`                  | Set one Transform base setting of a video track, keeping the others. Rejected while the setting has Transform keyframes, which it then follows.                                                                                                                                                           |
| `speed`               | `clipId`, `speed`                              | Set a clip's speed. Its duration changes with it: a Ripple track re-sequences the clips after it, and overlaps or transitions that no longer fit reject the edit.                                                                                                                                         |
| `reverse`             | `clipId`, `reverse`                            | Play a clip backwards or forwards; its duration and placement do not change.                                                                                                                                                                                                                              |
| `transform`           | `layerId`, `transform`                         | Replace a video track's Transform; it applies to every clip on the track at project time.                                                                                                                                                                                                                 |
| `detail`              | `clipId`, `detail`                             | Set a clip's static detail filters, applied before the track's Colour.                                                                                                                                                                                                                                    |
| `music`               | `music`                                        | Replace every music track of the project.                                                                                                                                                                                                                                                                 |
| `opacity`             | `layerId`, `opacity`                           | Set a video track's Opacity where it has no Opacity keyframes; it applies to every clip.                                                                                                                                                                                                                  |
| `layer-key-toggle`    | `layerId`, `frame`, `setting`, `value`         | Enable a setting at a track keyframe with value, creating the keyframe at frame if needed; or disable it there if it is already enabled, removing the keyframe with its last setting.                                                                                                                     |
| `layer-key-value`     | `layerId`, `frame`, `setting`, `value`         | Change the value of a setting already enabled at a track keyframe.                                                                                                                                                                                                                                        |
| `layer-key-move`      | `layerId`, `frame`, `nextFrame`                | Move a whole track keyframe, with all its settings and Easing, to another project frame; an occupied frame rejects the edit.                                                                                                                                                                              |
| `layer-key-remove`    | `layerId`, `frame`                             | Remove a whole track keyframe.                                                                                                                                                                                                                                                                            |
| `layer-key-default`   | `layerId`, `frame`                             | Add a default keyframe, which returns every Colour setting and Opacity to neutral from its frame on, or remove the default keyframe already there. Rejected where an ordinary keyframe exists.                                                                                                            |
| `layer-key-easing`    | `layerId`, `frame`, `setting`, `interpolation` | Set the Easing of a track keyframe's settings toward their next keyframes.                                                                                                                                                                                                                                |
| `layer-create`        | `layerId`, `name`                              | Add a video track on top of the others, with neutral Colour and Transform, Opacity 1, Ripple on and no clips; a project has at most 8.                                                                                                                                                                    |
| `layer-options`       | `layerId`, `name`, `enabled`, `ripple`         | Rename a video track, show or hide it, or turn its Ripple on or off; omitted fields keep their value. Turning Ripple on packs its clips from the first one's start; turning it off keeps their current starts.                                                                                            |
| `layer-remove`        | `layerId`                                      | Delete a video track and its clips; the last track cannot be deleted.                                                                                                                                                                                                                                     |
| `layer-order`         | `layerIds`                                     | Set the composition order of the video tracks, bottom first.                                                                                                                                                                                                                                              |
| `place`               | `clipId`, `layerId`, `start`, `index`          | Move a clip to a track and position. On a Ripple track the array position decides its place in the sequence and start must equal the resulting start, unless it is the first clip.                                                                                                                        |
| `move-clips`          | `clipIds`, `delta`, `layerId`                  | Move several clips together by the same number of frames. Overlaps, a start before frame 0 or transitions that no longer fit reject the whole move.                                                                                                                                                       |
| `transition`          | `transition`                                   | Set the transition between two adjacent clips of a track. Non-cut transitions need touching clips or an existing dissolve; without Ripple a dissolve or pause moves the right clip.                                                                                                                       |
| `fades`               | `layerId`, `opening`, `closing`                | Set a video track's fade from black at its first clip and to black at its last clip.                                                                                                                                                                                                                      |
| `bookmark-add`        | `frame`                                        | Add a bookmark, a snap point that is never rendered; at most 1,000.                                                                                                                                                                                                                                       |
| `bookmark-move`       | `frame`, `nextFrame`                           | Move a bookmark; an occupied frame rejects the edit.                                                                                                                                                                                                                                                      |
| `bookmark-remove`     | `frame`                                        | Remove a bookmark.                                                                                                                                                                                                                                                                                        |
| `select-set`          | `mediaId`, `ranges`                            | Replace a recording's kept ranges; an empty list makes the whole recording available again. Kept ranges never retime or render anything.                                                                                                                                                                  |
| `select-narrow`       | `mediaId`, `ranges`                            | Replace a recording's kept ranges with ranges inside the existing ones; it never keeps more frames.                                                                                                                                                                                                       |

<!-- operation-catalogue:end -->

## Operations

The first operations. Session and editor-only ones are listed because they share the
registry; the assistant never sees them.

| Operation            | Audience  | Purpose                                                                                                                                                                                                                                | Bounds                                                                                 |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `session_start`      | editor    | Start an assistant session: checkpoint, brief, lease token; refuses when a session is active or the revision is stale (the editor flushes autosave first)                                                                              | One session per project                                                                |
| `session_status`     | both      | State, brief, edit log, notes (editor banner and LLM resource)                                                                                                                                                                         |                                                                                        |
| `session_end`        | both      | Take over (editor) or finish with notes (assistant); the notes appear in the editor's hand-off dialog                                                                                                                                  |                                                                                        |
| `checkpoint`         | both      | Named checkpoint of the current document; `checkpoint_restore` (editor only) replaces the document in one revision after checkpointing the current state                                                                               | Last 5 per project                                                                     |
| `edit`               | both      | Apply a batch of commands atomically; with a session it also enforces selects and bin membership; returns the new revision and a one-line summary, or the first failing command's message                                              | ≤ 64 commands                                                                          |
| `preview_edits`      | assistant | Dry run of a batch against the saved revision: resulting timeline summary and errors, no save                                                                                                                                          |                                                                                        |
| `describe_project`   | both      | Compact timeline: tracks, clips with timecodes, transitions, music, bookmarks, selects, alignment summary; `detail: summary \| full`                                                                                                   |                                                                                        |
| `describe_track`     | both      | One video track's complete appearance (Colour with HSL and curves, Opacity, Transform, keyframes), its keyed settings and the values that apply at requested frames ([#252](https://github.com/Plonk42/PasCap/issues/252))             | ≤ 32 frames                                                                            |
| `describe_recording` | both      | Shot descriptors (below) inside the selects, flight data, damage, `allowedMovement`, a sheet of each steady range's middle frame ([#239](https://github.com/Plonk42/PasCap/issues/239))                                                | Computed on request, no cache                                                          |
| `still`              | both      | One composed project frame from the proxies (`frame`, `width`, `crop?`, `commands?` for a candidate), JPEG ([#238](https://github.com/Plonk42/PasCap/issues/238))                                                                      | Serial, two waiting; refused (409) while an export or reference job runs; image budget |
| `timeline_sheet`     | both      | Contact sheet of project frames (`frames[]`, `commands?`), JPEG plus legend                                                                                                                                                            | Same as still                                                                          |
| `recording_sheet`    | both      | Contact sheet of a recording's proxy frames (`mediaId`, `frames[]`), ungraded, JPEG plus legend                                                                                                                                        | Same as still                                                                          |
| `estimate`           | both      | Auto adjust, Auto white balance or detail measurement of a clip (whole, or 1 s around a frame), a track or a recording range, with the edit commands applying it (below, [#240](https://github.com/Plonk42/PasCap/issues/240))         | Serial with stills; ≤ 16 proxy frames                                                  |
| `music_analyse`      | editor    | Not an operation: the editor queues the job (**Analyse music**) and the Hand off dialog's readiness list queues it; `music_analysis` (both) returns tempo, meter, beats, accents and sections at project frames, in an optional window | Background job kind                                                                    |
| `check_alignment`    | both      | Boundary-to-beat report (below)                                                                                                                                                                                                        | Pure, bounded by clip/beat counts                                                      |
| `snap_cuts_to_beats` | both      | `layerId`, `prefer: beat \| downbeat`, `minimumSeconds`, `apply`: the alignment helper, a proposal or one `edit` batch                                                                                                                 |                                                                                        |
| `beats_to_bookmarks` | both      | Not an operation: the assistant adds `bookmark-add` commands for the frames `music_analysis` lists; the editor snaps to beats directly (**Snap to beats**)                                                                             | ≤ 1,000 bookmarks                                                                      |

There are deliberately no `add_clip`/`set_transition`-style wrappers: those are `edit`
commands, already described in `editCommandSchema`, and a wrapper would be a second place
to maintain. The brief carries no permissions: every command is available.

### Stills and contact sheets

Implemented on the `mcp` branch ([stills](../../src/server/stills.ts)). Pipeline for project
frame $f$, at the 1280 × 720 draft size:

1. `sampleTimeline(document, f)` and `sampleSlots` give the active sources with evaluated
   Colour, Transform, Detail, weights and Opacity.
2. Each source decodes proxy frame `sourceFrame` with FFmpeg: input `-ss` a quarter frame
   before it, so accurate seeking returns exactly that frame (a native test compares it with
   a full decode across GOP boundaries), fitted and padded like the export's decode, as
   `rgb24`. Damaged ranges follow the proxy, which is already black there.
3. Each enabled track is composed as one group with `composeLayerFrame` on the CPU
   compositor pool, then source-over the tracks below with the export's `sourceOverGroup`
   ([group composition](../LAYERS_AND_KEYFRAMES.md#group-composition)); timeslots draw
   geometry without decoding.
4. Over opaque black, the RGB is rounded to 8 bits; FFmpeg scales it (area) and encodes
   one JPEG. Sheets tile the frames row by row with a 4-pixel black gap and return a legend
   `{ cell, frame, timecode, clipIds }` instead of burnt-in text.

Operations return the JPEG base64-encoded in JSON with its size; the MCP endpoint will turn
it into image content. Optional `commands` apply to the saved revision in memory before
composing, so the LLM can compare a grade or a transition without a revision; they are
validated like an `edit` and against the recordings' frames, and never written. A `crop`
renders a region of the 1280 × 720 composition at 1:1, to judge Sharpen and Denoise. Stills
show the 720p proxy composition: the export at 4K differs in resolution only, as the preview
does ([detail filters](DETAIL_FILTERS.md#kernel)).

The image budget is service configuration with conservative defaults:
`PASCAP_ASSISTANT_STILL_WIDTH` (480; still width and largest crop side, 160–1280),
`PASCAP_ASSISTANT_SHEET_CELL_WIDTH` (240, 96–640) and `PASCAP_ASSISTANT_SHEET_CELLS` (16,
1–24). A request may ask for less, never more; a single-frame sheet renders at the still
width. At the defaults a still is about 35 KB and a 4 × 4 sheet 972 × 556.

Every picture stays in the client's conversation, and many clients limit how many it may
hold: VS Code with Claude refuses a request carrying more than 20, after which the conversation
cannot continue ([#243](https://github.com/Plonk42/PasCap/issues/243): a run that looked at
each candidate in its own sheet reached 21). That limit belongs to the client, not to PasCap,
which enforces none (owner, 2026-10-21): the guide asks the assistant to spend pictures where
they decide something (one `compare_recordings` sheet of many candidates, one `timeline_sheet`
of the cut) and, when its client has subagents, to let them look at groups of recordings in
their own conversations. `describe_recording`'s sheet is opt-in, and sheets hold 16 cells by
default.

Measured read-only on the owner's flight (one track, Shadows keyed; 16-thread host): a still
takes 0.6–0.8 s and a 9-frame sheet 6 s. Shadows, Highlights, HDR, Local contrast and Detail
use the neighbourhood kernel, about 3 s per 720p frame in process and 1 s on the pool;
the GPU worker is not used.

### Shot descriptors

Implemented on the `mcp` branch ([#239](https://github.com/Plonk42/PasCap/issues/239),
[recording shots](../../src/shared/recording-shots.ts)). PasCap does no pattern recognition
(owner, 2026-10-21): `describe_recording` maps where a recording is usable and how its camera
moves; the model judges what it shows from pictures. From the cached motion analysis and
flight data, without decoding:

- the steady ranges at the allowed movement (the request's, else the active session brief's,
  else 2), as Source preview finds them (`smoothRanges`, damaged frames excluded), cut to the
  project's kept ranges (pieces under 2 s dropped), in source order; each with its length,
  mean and peak picture movement (% of image width per second), mean roughness, a camera move
  name and mean flight data (height, horizontal and vertical speed, distance from home);
- the camera move is arithmetic on the mean `tx`/`ty`/`zoom`/`rotation` of the range, read as
  the move that would cause it: content moving right is a pan left, down a tilt up, growing a
  push in, plus rotation; a component carrying 60 % of the movement names it alone, else the
  two largest are named; under 0.5 % of the width per second it is `static`. A sideways
  flight looks like a pan and an orbit like a pan; the names describe the picture, not the
  flight;
- recording facts: name, duration, damaged ranges, the share of still frames (hovering)
  and whether flight data exists;
- unless `sheet` is false, one contact sheet (`recording_sheet`) of each range's middle
  frame, the longest ranges first when they do not all fit the image budget, with each
  range's `cell`.

The thumbnails' picture facts first proposed (mean luma, colourfulness) were dropped: the
model sees the pictures. A recording without motion analysis returns no ranges and
`motionAnalysed: false`; an unprepared one is refused.

Flights often hold several near-identical takes of one subject, of which the user keeps only
the best. `compare_recordings` shows candidates from several recordings in one ungraded
sheet: each candidate is a recording and a source range (by default its longest steady range
inside the kept ranges at the session's allowed movement, else its first kept range or the
whole recording), shown in 1–4 cells at the centres of equal parts of the range, one row per
candidate when there are several cells. Its legend gives each candidate's cells, range, length
and frames. Like the other sheets it is limited by the image budget's cells per sheet
(16 by default: sixteen candidates, or four with four cells each).

### Server-side Auto adjust, white balance and detail measurement

Implemented on the `mcp` branch ([#240](https://github.com/Plonk42/PasCap/issues/240),
[estimate](../../src/server/operations/estimate.ts)). `estimate` analyses one target and returns
values plus the `edit` commands that apply them; it edits nothing itself:

- **clipId**: the whole clip, the frames **Auto**'s Clip source reads (`autoAdjustFrames`);
  with `frame`, the project frames within 1 s of it in the clip, mapped through retiming, as the
  Playhead source and **Auto white balance** read them (white balance weighs each project frame,
  Auto adjust each source frame once, as in the editor);
- **layerId**: every clip of the track by duration (`trackSamples`), as the Track source;
- **mediaId** with `sourceIn`/`sourceOut`: a recording range, values only.

`kind: auto-adjust` runs `analyseAutoAdjust` and scales the correction by `intensity` (80 %
is the fitted correction); `white-balance` runs `frameIlluminant` and `poolWhiteBalance`. Their
commands are the editor's: track values as one `colour` edit leaving animated settings unchanged
(listed in `unchanged`), or with `applyAs: keyframe` the settings captured at `frame` like their
diamonds ([shared helpers](../../src/shared/auto-colour.ts)). The frames are decoded on the
still renderer's serial queue from the proxy with FFmpeg, at the editor's analysis size
(`analysisSize`, 320 × 180 for a 720p proxy) in RGBA, area-scaled with full chroma
interpolation. That is the exact BT.709 conversion (checked at patch centres within one code);
the browser's canvas readback is not bit-identical: Chrome's unscaled path (libyuv) uses 2.0
for BT.709's blue coefficient 2.112. On a synthetic flat proxy the fitted settings agree with
the page's within 0.07 (Whites and Temperature differ most; most within 0.02), checked by a
browser test at 320 × 180 and 1280 × 720. A request takes about 2 s for 16 frames of a
720p proxy.

`kind: detail` measures proxy luma at the proxy's own size, the 720-line scale whose units the
detail filters use ([detail estimate](DETAIL_FILTERS.md#detail-estimate)), on up to 8 frames,
and suggests Denoise and Sharpen with a `detail` command for a clip. The proxy is a clean
H.264 encode downscaled from the original, so it shows little of the original's noise: on the
owner's DJI recordings it measures almost none. The suggestions are starting values to judge on
a 1:1 `still` crop; Clarity is a look and is never suggested. Compression blockiness, first
proposed, is not measured: the proxy's blocks are its own encode's, not the original's.

## Music analysis

Implemented ahead of the registry (owner, 2026-10-20): the job and cache are served by
`GET`/`POST /api/audio/<id>/analysis`, described in
[speed and audio](../SPEED_AND_AUDIO.md#music-analysis). The assistant reads it through
`music_analysis` ([#241](https://github.com/Plonk42/PasCap/issues/241)): for each music clip of
the project, tempo, meter, beats with downbeats and strength, accents and sections mapped to
project frames through the clip's placement, source range and loops (`musicBeatFrames`,
`musicSampleFrames`, `musicSampleRanges` in [beat alignment](../../src/shared/beat-alignment.ts)),
in an optional frame window, at most 2,000 beats per clip. The design as proposed:

Runs in a worker thread (as `motion-pool` does), streaming the PCM cache in 1 MiB blocks,
mono downmix in float; no new dependency (a small radix-2 FFT in TypeScript).

| Stage          | Method                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features       | 2,048-sample Hann window, hop 480 (100 Hz); 40 triangular bands 30 Hz–16 kHz, log compression                                                                                                                                                         |
| Onset envelope | Half-wave rectified spectral flux summed over bands, smoothed, normalised; 12-bin chroma-lite per frame for structure                                                                                                                                 |
| Tempo          | Autocorrelation of the envelope over 8 s windows with a log-normal prior centred at 120 BPM, candidates 50–220 BPM (Ellis 2007); global tempo and a per-window curve; octave errors resolved towards the prior; confidence from the peak's prominence |
| Beats          | Dynamic-programming beat tracking on the envelope at the local tempo, refined to the nearest onset peak within ±20 ms; `strength` from the envelope                                                                                                   |
| Downbeats      | Among 4 (then 3) phases, the one maximising mean onset strength plus low-band energy at candidate downbeats; `meter` with a confidence; a heuristic the LLM may ignore                                                                                |
| Loudness       | RMS per 100 ms in dBFS                                                                                                                                                                                                                                |
| Sections       | Novelty from a checkerboard kernel over the self-similarity of 1 s band-energy and chroma averages; boundaries at prominent peaks with sections ≥ 8 s; kinds from relative loudness and slope (`quiet`, `build`, `peak`, `release`)                   |
| Accents        | Envelope peaks above the 90th percentile at least 150 ms apart: hits worth cutting on                                                                                                                                                                 |

Bounds: features for a 10-minute song are 60,000 × 40 floats (about 10 MB) and the PCM is
never held whole; one analysis at a time, in the background after other jobs, cancellable,
tied to the PCM cache's identity like `motion-v3.json` is to the proxy's `verifiedAt`.
Missing analysis for an older cache shows an explicit **Analyse music** action; nothing is
rewritten silently.

Validation uses synthetic signals only: click tracks and amplitude-modulated noise at
60–200 BPM with offsets, swing, a tempo change and added noise; beats within ±35 ms
(about one project frame) at F-measure ≥ 0.95, tempo within 2 % (or its double/half
flagged), downbeats ≥ 0.8 on accented bars, sections at synthetic loudness steps;
deterministic results; a loop-placed music track maps beats to project frames across the
wrap. Real songs are evaluated by the owner, not by CI.

Editor value independent of the assistant: beat ticks (downbeats stronger) on each music
lane from its analysis, with its sections, swells, silences and tone, and **Snap to beats**
beside **Snap** in the timeline toolbar (beats or downbeats only, following each music
clip's placement), after which every snapping gesture lands on the beat without writing
anything to the project ([snap to beats](../TIMELINE_EDITING.md#snap-to-beats)).

### Alignment helpers

Implemented on the `mcp` branch ([#241](https://github.com/Plonk42/PasCap/issues/241),
[beat alignment](../../src/shared/beat-alignment.ts)); beats are those of every analysed music
clip on the timeline (or one), merged by frame.

- `check_alignment`: for every boundary of every video track (or one), the moment the viewer
  perceives (the cut; the middle of a dissolve's overlap; the middle of a black pause's slot;
  a fade through black's boundary), the nearest beat and downbeat with signed offsets in
  frames (positive: the change comes after the beat), and a summary: boundaries within one
  frame of a beat or downbeat and the mean absolute offset.
- `snap_cuts_to_beats`: on one Ripple track, left to right, trims each boundary's left clip
  (its OUT as displayed, so source IN for a reversed clip) so the perceived moment lands on
  the nearest beat or downbeat, before or after it. Moving it earlier shortens the clip, like
  the editor's **Trim end**; moving it later lengthens the clip, when its recording has the
  footage inside its kept ranges. When the nearest beat cannot be reached, the nearest on the
  other side is tried. Each clip stays at least `minimumSeconds` long; transitions keep their
  durations and later clips follow, so a cut keeps about its length instead of drifting
  earlier at every boundary. A boundary that reaches neither beat stays put with the reason.
  Returns the `trim` commands and each boundary before and after as a proposal, or with
  `apply` and `expectedRevision` saves them as one `edit` (the session rules apply). With slow
  motion a boundary can land a frame from the beat; `after` says where.
- No `beats_to_bookmarks` operation: bookmarks are `bookmark-add` commands at the frames
  `music_analysis` lists. Not done: the first/last video frame against the music's first and
  last beat, and lengthening clips.

## MCP server

Implemented on the `mcp` branch ([#242](https://github.com/Plonk42/PasCap/issues/242),
[mcp.ts](../../src/server/mcp.ts)) with the official MCP TypeScript SDK v2
(`@modelcontextprotocol/server` and `@modelcontextprotocol/node`): `/mcp` on the service's
loopback port is its `createMcpHandler`, mounted on Fastify with `toNodeHandler` after the
token check (`reply.hijack()`). It serves the 2026-07-28 protocol revision and, for
2025-era clients, stateless Streamable HTTP; each request gets a fresh `McpServer` from one
factory, so both eras offer the same tools. The SDK handles negotiation, `tools/list`,
`tools/call`, notifications, JSON-RPC errors and the 405 for session `GET`/`DELETE`. The
tools are registered in a loop from the operations whose `audience` includes `assistant`:
name, description, the zod input schema (published as JSON Schema with its nested
descriptions, and validated on every call) and a read-only hint from `access`. A call runs
the same `runOperation` as the HTTP route; pictures become image content beside a JSON text
legend, other outputs JSON text, and a rejected call is a tool error carrying the service's
reason, so the model can correct it. An unknown tool is a protocol error.

The owner preferred the standard SDK to a hand-written endpoint (2026-10-21): it follows the
protocol as it evolves, and resources, prompts, progress or subscriptions come with it. v2 is
the SDK's stable line (v1, `@modelcontextprotocol/sdk`, only receives fixes); its server needs
zod 4, which PasCap already uses, and adds five production installations (the SDK's three
Apache-2.0 packages, Hono and its Node adapter) ([licensing](../LICENSING.md)).

Authentication is a bearer token generated at the first startup and kept in
`<dataDir>/mcp-token` (owner-only, like the rest of the data directory); `/mcp` is exempt
from the `x-pascap-client` rule and keeps the Host/loopback and Origin checks. The VS Code
configuration is in [development](../DEVELOPMENT.md#mcp-endpoint); the Hand off dialog will
show it. Clients that only launch stdio servers use `npx mcp-remote
http://127.0.0.1:4318/mcp --header "Authorization: Bearer …"`; PasCap ships no process of
its own.

Conventions, by the operations rather than the endpoint: frames are authoritative and
outputs also carry `MM:SS:FF` timecode (30 fps NDF, as the editor shows); every write returns
the new revision; validation failures are tool errors with the service's message (for
example an overlap or an invalid fade), never exceptions.

### Resources and prompt

Implemented: one resource, `pascap://guide` (Markdown), holding the playbook below
([assistant-guide.ts](../../src/server/assistant-guide.ts) is its text), and one prompt,
`rough_cut { request? }`, which hands the playbook to the model with the user's request. The
server instructions point to both. Clients differ: VS Code shows the prompt as
`/mcp.pascap.rough_cut` and lets the user attach the resource, but its model cannot read a
resource on its own, so the instructions also name the key tools.

The other resources first proposed are not built: each duplicated an operation the model calls
anyway (`session_status`, `describe_project`, `describe_recording`, `music_analysis`), and
resources need the client's cooperation to reach the model.

| URI              | Content                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `pascap://guide` | The assistant playbook below, so the client needs no custom system prompt |

### Tools

The tools are exactly the operations with `assistant` in their audience; the generated
catalogue in this guide is their reference. Everything that changes the project goes
through `edit`, whose command vocabulary is `editCommandSchema`: inserting, trimming,
placing and removing clips, transitions, fades, music, Colour (including an Auto adjust
result applied through `colour`), Detail, speed, Reverse, Transform, tracks, bookmarks,
keyframes and the new `select-narrow`. The playbook, not the tool list, says when to use
which command (for example static grades unless the brief wants animation).

### Guards

- No assistant operation takes a filesystem path, imports, prepares, relinks, exports,
  deletes a project or removes a recording from the project; `audience` is a required
  field, so an operation cannot reach the assistant by omission.
- Session required for every write; the lease belongs to the MCP session inside the
  service, so no token ever reaches the LLM. A take-over or expiry ends the session: later
  writes fail with "The user took the project back."
- Selects, bin membership and brief permissions are enforced in the service's `edit`, not
  in the MCP layer.
- Image responses are at most 1 MB each; stills and estimates are serialised and refused
  during exports; the service applies the same 120 s request timeout as today.
- Every batch is validated like a save (`projectSchema`, layout, `assertProjectSources`).

## Hand-off in the editor

Follow mode, Take over, restore and the Hand off dialog are implemented on the `mcp` branch
([#236](https://github.com/Plonk42/PasCap/issues/236), [AssistantSession.tsx](../../src/web/AssistantSession.tsx)):

- While the page is visible the editor polls `session_status` (without checkpoints) every
  1.5 s. During an active session it shows a banner, **An assistant is editing this project**,
  with the edit count, the last command and **Take over**. Edits and Undo/Redo are refused
  with a message; whenever the editor is idle (no draft, gesture or pending save) it adopts
  each newer saved revision, replacing its history like a project switch. A draft the user
  had before the session stays in the editor, its saves refused (423) until the session ends.
- The preview follows the assistant: each `edit` records in the session's edit log the
  earliest project frame it changed (`editedFrame` in [edited-frame.ts](../../src/shared/edited-frame.ts):
  clips and their placement, transitions, fades, keyframes, bookmarks and music clips), and
  adopting a revision seeks to the latest such frame, unless the preview is playing. Changes
  without a particular frame (a whole track's Colour, Opacity or Transform, kept ranges, the
  title) leave the playhead where it is.
- **Take over** calls `session_end`. When a session the editor saw ends (Take over, the
  assistant's `session_end` with notes, or expiry), the editor adopts the latest revision once
  and shows who ended it, the edit count and the notes, with **Restore project before
  session**: `checkpoint_restore` of the session's start checkpoint, after checkpointing the
  current state, in one revision; the editor reloads it with a fresh history. **Open as new
  project** (`checkpoint_copy`, editor only) saves that checkpoint as a new project titled
  "… (before assistant)" and opens it, leaving the assistant's version as it is. An **Edit
  log** disclosure lists the session's batches, each with a timecode button seeking to the frame
  it changed. The summary is dismissed with ×.
- **Hand off** (header, beside Export; [HandOff.tsx](../../src/web/HandOff.tsx)) opens a
  dialog with the brief's fields (notes, a placed music track or Any, target length, allowed
  movement, most clips) and **What the assistant can use**, from `hand_off_readiness`
  (editor only): bin recordings prepared, their camera motion analysed, music prepared and
  analysed, a running export. Missing jobs are queued from the dialog (**Prepare N**,
  **Analyse N**) and the list refreshes every 2 s while they run; none of it blocks the
  hand-off (decided 2026-10-21: the assistant works with what is ready). Confirm flushes
  autosave and calls `session_start` with the brief.

- **Assistant connection**, below the readiness list, says whether an MCP client has called
  PasCap with the token since the service started (`hand_off_readiness.connection`: the last
  call's time and the name the client gave, from `initialize` or the 2026 revision's
  `io.modelcontextprotocol/clientInfo` meta), refreshed every 5 s. **How to connect** gives the
  endpoint, the token file and a VS Code `mcp.json` entry that prompts for the token, with
  **Copy configuration**; the token itself never reaches the editor.

The dialog places no music (owner, 2026-10-21): placing is an edit, not part of a brief. The
**Music track** field names a placed track; with none placed, the assistant finds the project's
music recordings in `describe_project` and places one with the `music` command, or the user
places it on the timeline first.

## Assistant playbook (the `pascap://guide` resource)

The LLM is told what good looks like and what PasCap can do; the tools do the arithmetic.

1. **Read** the session brief, the project and the recordings. Note the music's tempo,
   sections and length; decide the target duration (music length unless the brief says
   otherwise; the music fades out if the cut is shorter).
2. **Select**: for each recording, read its shots inside the selects; look at a contact
   sheet of each candidate steady range; keep the strongest ranges (composition, light,
   movement that completes within the range) and narrow selects for the rest. Prefer
   whole camera movements over fragments; avoid damaged and hovering stretches.
3. **Structure**: order shots to tell the flight (chronological or by place, wide
   establishing shots at section starts, the most dramatic movement on the music's peak,
   calm shots in quiet sections); plan clip lengths from the sections and the beat grid
   (longer clips on slow music, cuts on downbeats at peaks). Use a second track only for
   deliberate overlays the brief allows.
4. **Build** on one Ripple track with `edit` (`insert` commands) in order, then
   `snap_cuts_to_beats`;
   check `check_alignment` and a `timeline_sheet` around each boundary. Set transitions:
   cuts on beats, short dissolves (8–15 frames) between related shots, fade through black
   between sections, opening and closing fades matching the music's fade.
5. **Grade**: per track, `estimate auto-adjust` on a representative clip and apply at
   80 %; compare `still`s of two or three frames per clip before and after; adjust
   Temperature/Tint or Exposure per track when shots differ, moving a clip to its own
   track if it needs its own grade. Set Detail per clip from `estimate detail`, verified
   on a 1:1 crop (no halos, no waxy denoise).
6. **Verify**: a full `timeline_sheet`, the alignment report, the duration against the
   target, every clip inside its selects, music fades; then `session_end` with notes
   naming the structure, the choices and anything the user should look at.

The served text ([assistant-guide.ts](../../src/server/assistant-guide.ts)) follows these
steps with the tools that exist: footage from `describe_recording`, `compare_recordings` and
`recording_sheet`, the
music from `music_analysis`, `preview_edits` before a batch, and grading from `estimate` and
`describe_track` with candidate `still`s.

## Delivery plan

Each phase is one or more issues; routes follow [the workflow](../GITHUB_WORKFLOW.md).
Persisted formats, service routes and the new dependency are risky (PR with
auto-merge); editor UI and docs are routine.

| Phase | Work                                                                                                                                                                                                                                                                                                              | Route                                                             | Validation                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundations, no behaviour change: `editCommandSchema` with descriptions (type-equality test), the operation registry with its HTTP loop, typed web client and catalogue script, first operations `describe_project` and `edit`                                                                                    | #228 routine (refactor); #229 PR (new route family, check script) | Unit: registry drift gates, HTTP contract test, `applyCommand` suite unchanged; `npm run check` catalogue check                                                                                         |
| 1     | **Implemented:** Project `selects` (schema bump, migration, fixture, `select-set`/`select-narrow` commands), Source preview applies to selects, **Keep this range too**                                                                                                                                           | Risky (schema)                                                    | Unit: schema/migration/commands; browser: source range round trip; fixture compatibility                                                                                                                |
| 2     | **Implemented:** music analysis job, cache, REST routes `/api/audio/:id/analysis`, beat ticks on music lanes, **Snap to beats** ([#256](https://github.com/Plonk42/PasCap/issues/256)); the `music_analyse`/`music_analysis`/`beats_to_bookmarks` operations come with the registry when the assistant needs them | Risky (format)                                                    | Unit: synthetic beat/tempo/section gates, worker bounds, cancellation; browser: ticks and beat snapping; `test:media` for the PCM reader                                                                |
| 3     | Session operations (lease, checkpoint, brief, 423/409 paths, selects and permission enforcement in `edit`), editor **Hand off**/follow mode/**Take over**/**Restore checkpoint**                                                                                                                                  | Risky (routes)                                                    | Unit: lease, atomic batch, enforcement; browser: hand-off dialog, follow mode, take-over, restore                                                                                                       |
| 4     | `still`, `timeline_sheet`, `source_frame`, `describe_recording`, `estimate` (Auto adjust/AWB/detail), `check_alignment`, `snap_cuts_to_beats`                                                                                                                                                                     | Risky (native)                                                    | Unit: still equals the layered-export frame for the same project (same compositor), sheet legend, estimator tolerance against the browser path, snap-cuts arithmetic                                    |
| 5     | MCP endpoint: SDK dependency and licence inventory, registry-to-tools loop, resources and guide, `/mcp` transport and token, docs (USER_GUIDE, DEVELOPMENT, DEPLOYMENT, this guide becomes the contract)                                                                                                          | Risky (deps)                                                      | Unit: in-memory MCP client runs a scripted session end to end against a memory service through the registry; the contract test covers every assistant operation over both surfaces; no real model in CI |
| 6     | Owner evaluation on real flights (consent): playbook and heuristic tuning, image budgets, timings; decide progress notifications and Phase 2 of Auto adjust                                                                                                                                                       | —                                                                 | Evidence in the issue, not CI                                                                                                                                                                           |

Phase 0 is a refactor that pays for itself in the editor (typed operations, bulk actions)
and removes the MCP's maintenance cost before it exists. Phases 2 and 4 are useful without
the MCP; Phase 1 unblocks the "never add back" rule. Phase 5 cannot start before 3 and 4,
and is small once the registry exists.

Docs to update when each phase lands: [TIMELINE_EDITING](../TIMELINE_EDITING.md)
(selects, beats as bookmarks), [SPEED_AND_AUDIO](../SPEED_AND_AUDIO.md) (music analysis
and cache), [WORKSPACE_AND_RECOVERY](../WORKSPACE_AND_RECOVERY.md) (hand-off, follow
mode, checkpoints), [DEVELOPMENT](../DEVELOPMENT.md) (operations, `/mcp`, resource
bounds), [USER_GUIDE](../USER_GUIDE.md), [DEPLOYMENT](../DEPLOYMENT.md) (the `/mcp`
endpoint, token and loopback), [EDITOR_CONTROLS](EDITOR_CONTROLS.md) (new controls) and the
[README index](../README.md).

## Open questions for the owner

1. Same project with a lease and checkpoint (proposed) or always a copy? **Answered: same
   project with a lease and checkpoints, which the user can use on large projects too.**
2. Should the assistant be allowed to create tracks, use Transform overlays and speed
   changes by default, or only when the brief allows (proposed: brief flags, all off
   except several tracks)? **Answered: no permissions; it may use every operation.**
3. Which LLM client first (VS Code, Claude Code, Codex, Claude Desktop through
   `mcp-remote`)? The dialog's configuration snippet targets the first one.
   **Answered: VS Code.**
4. Do the user's first-pass ranges also need **exclusions** (ranges to avoid inside a
   kept range), or are several kept ranges enough (proposed)?
5. Should beat ticks and beat snapping ship before anything assistant-related
   (proposed: yes, Phase 1 is user-facing on its own)? **Answered: yes; shipped.**
6. Image budget: default 640 × 360 and 12-cell sheets, or smaller to save tokens?
   **Answered: service configuration, conservative defaults.**
7. Should the editor's existing REST routes migrate to operations when touched (proposed),
   or stay as they are indefinitely? **Answered: when touched, or on demand.**

## Risks and limits

- Beat tracking is weakest on ambient or rubato music; low confidence is reported and the
  playbook falls back to sections and loudness. Downbeats and sections are heuristics.
- The LLM's cost is dominated by images; the text summaries, sheets and the alignment
  helper exist to keep iterations cheap. Long sessions should checkpoint.
- Server-side Auto adjust agrees with the editor's within a tolerance, not exactly, because
  the browser and FFmpeg scale differently.
- Stills are proxy-resolution compositions; fine detail at 4K is judged at export, as in
  the preview today.
- The MCP SDK is a production dependency of the service, mounted on Fastify through a raw
  request hijack; upgrading it follows the risky route. A `tsx watch` restart during
  development drops in-flight tool calls, as it ends an export.
- Automatic exposure is not automatic guidance: a new command appears in `edit` by itself,
  but the playbook may need a sentence, and `.refine()` rules are invisible in JSON Schema
  until the model reads the error message.
- The registry covers new work; the editor's existing routes migrate only when touched,
  so two route styles coexist for a while.
- Follow mode polls; a long assistant session keeps the tab's preview decoding on each
  revision. The interval and the "jump to last edit" behaviour need live checks.
- Nothing here changes rendering, export routing, resource budgets or the proxy/PCM
  formats; the schema bump adds one field with an empty migration default.
