# Auto edit

Auto edit builds a complete first cut **without an LLM**: one deterministic algorithm chaining the
analyses PasCap already has (steady ranges and shot kinds, flight data, kept ranges, music
analysis, Auto, Match) into shot selection, ordering, cut lengths on the music, transitions, fades
and grading. The same project, brief and choices always give the same cut. The user, or an
assistant with a few pictures, then judges what PasCap cannot see: subjects and composition.

Owner decisions (2026-11-20): the editor builds the cut in a **copy** of the project; flight order
by default with an energy order as an option; music the brief names is placed when the timeline
lacks it; the default grade is Auto per clip then a match to a representative clip; flight order
comes from recording names (no capture time is stored); no pattern recognition or image model.

## Where it runs

One pipeline (`src/server/auto-edit.ts`, pure stages in `src/shared/auto-edit/`) serves both:

- **Editor**: the Hand off dialog's **Auto edit** section starts the editor-only operation
  `auto_edit_start` with the dialog's brief and choices. It runs as an Activity job (kind
  `auto-edit`, one heavy job at a time like the others) with progress. `into: copy` saves the cut
  as a new project, “<title> · Auto edit”, and leaves the project unchanged; the job's message
  summarizes the cut. **Open the auto edit** (or **Open** in Activity) reads the result with
  `auto_edit_result`, opens the copy and shows the report. **Try again** in the report starts the
  job on the open copy with `into: project` and the next variant: the service keeps the new
  project document in the result, and the editor applies it as **one Undo step**, keeping the
  project's ID and title. The browser remembers the result shown for a project
  (`pascap-auto-edit-<projectId>`), so the header's **Report** reopens it there; the editor asks for
  nothing on other projects.
- **Assistant**: `auto_edit` (MCP) builds the same cut on the user's project inside the
  assistant's session: a new Ripple track **Auto edit** above the others, which it hides, with the
  enabled adjustments turned off. With `apply` and `expectedRevision` it saves the cut as one edit
  through `edit`'s checks and session rules; without, it returns the commands (often more than
  `edit` takes at once). The brief defaults to the active session's.

Results are kept in `<dataDir>/auto-edit/<job id>.json` (the 30 newest), never in projects.
Nothing is imported, prepared, exported or deleted, and the project schema is unchanged; the brief
gained the optional `musicId`.

## Inputs

The **brief** (`briefSchema`): `musicTrackId` or `musicId` (the music), `targetSeconds`, the
steady-range limits, `maxClips` and `style`; its `notes` are for the assistant only. The
**choices** (`autoEditChoicesSchema`): `pace` (calm, balanced, energetic), `order` (flight,
energy), `transitions` (auto, cuts, soft), `grade` (match, auto, none) and `variant` (0–99).

## Pipeline

Every constant is in the frozen `AUTO_EDIT` (`src/shared/auto-edit/constants.ts`).

### Recordings and music

Recordings of the bin that are not prepared, or whose camera motion is not analyzed, are skipped
and listed in the report. The music followed is the brief's music track; else the track already
playing the brief's recording, or a new music track placing it at frame 0 from the end of its
leading silence; else the project's first music track; else none (even clip lengths). Music
without its analysis refuses the auto edit with the reason; analyzed music without a steady beat
cuts on even lengths and its strong hits, with a note.

### Candidates

`recordingShots` gives each recording's steady ranges inside its kept ranges and within the
brief's steady limits, with kind, rank, speeds, jolts and flight means. A candidate is one range
of at least `minimumSeconds` (1.5 s); each recording keeps its best `candidatesPerRecording` (8),
and the cut its best `maximumCandidates` (160). Flight order is the natural order of recording
names (DJI files number themselves), then source IN. A candidate also records where its movement
runs without its start and end ramps (frames below `rampShare` of its median speed) and its
**completeness**: half a point for each end whose first or last tenth moves below
`completeShare` of its peak.

### Pictures

Each candidate's proxy is decoded at three frames (`pictureShares`: 1/6, 1/2, 5/6 of the range,
analysis size, RGBA) and its middle frame as full-size luma, one recording at a time on the still
renderer's queue. They give the share of clipped (any channel ≥ `clippedCode`) and crushed (luma ≤
`crushedCode`) pixels, the encoded luma spread (p95 − p5), Hasler–Süsstrunk colorfulness, the
detail estimate's softness, and each frame's coarse log-luma layout (`frameLayout`, as Match's
scene likeness reads it).

### Quality, energy, establishing

Risks, each 0–1: **exposure** (clipped plus crushed share past `exposureAllowance` over
`exposureRange`, plus up to half for ISO above `iso.from`), **blur** (softness past `blur.from`)
and **flat** light (spread and colorfulness below `flat`). The quality of a candidate of kind
weight $w_k$ (`SHOT_WEIGHTS`), $L$ seconds long with mean jolts $j$ under the limit $J$:

$$q = w_k \cdot \frac{\min(L, 10)}{10} \cdot \left(1 - 0.7\min(1, j/J)\right)^{0.5} (1-\rho_e)^{1.5} (1-\rho_b) (1-\rho_f)^{0.5} (1 + 0.25\,c)$$

Energy $e = 0.5\,P(\text{picture speed}) + 0.3\,P(\text{flight speed}) + 0.2\,k$, where $P$ is the
percentile among candidates and $k$ the kind's energy (orbit 0.8 … static 0). A reveal is an
**establishing** shot, as is a high, far and calm one (height and distance percentiles at least
0.7 and 0.6, speed at most 0.5).

### Alike takes

Two candidates are alike when the best similarity of their frames' layouts reaches
`cluster.similar` (0.82), or `cluster.nearSimilar` (0.68) when their flight data and order say
they are near (heights within 15 m, distances within 60 m, at most two recordings apart; without
flight data, only within one recording). Single-link clustering joins the most alike first while
a cluster spans at most `cluster.span` (6) recordings. In each cluster the best quality is the
take of choice; the others keep `score.duplicate` (0.35) of their quality, so they fill a cut only
when it needs them. The report lists the clusters used and the takes they left out.

### Music grid

The cut starts with the music and lasts the target, else the music (never past it), ending on the
last section end, else downbeat, at most `endBars` (2) bars before. Boundaries are **forced** at
section starts, sudden swells and silence edges (each on its nearest beat). Between them, each slot
wants the seconds of its section kind at balanced pace — quiet and release 6, build 5.5 to 4,
peak 4 to 3, shortening through the section; without sections `beatlessSeconds` (4.5) — times the
pace (calm 1.4, energetic 0.65): aerial shots need time whatever the tempo. The boundary is the
downbeat nearest the wanted length within 0.6–1.6 times it (a strong hit within a beat of that
downbeat wins), else a beat, else a strong hit. A last piece up to 1.4 times the wanted length
stays whole; slots stay within 1.5–12 s (longer ones split at the downbeat nearest their middle);
`maxClips` merges the shortest slot into its shorter neighbor. Each slot's energy blends its
section kind (quiet 0.15, release 0.35, build 0.6, peak 0.9) with the percentile of its loudness.

### Assignment

A candidate fills a slot only when at least as long. Its score there:

$$S = q \cdot \text{fit} \cdot d - 0.35\,|e - E| + 0.3\,[\text{establishing} \wedge \text{opens}] \cdot (1.5 \text{ on the first slot})$$

where fit falls by up to `score.fragment` (0.25 for reveals and approaches, half that for other kinds)
when the range is more
than twice the slot, $d$ is 1 for the take of choice and 0.35 for another take of its cluster, and
`opens` marks the first slot of the cut or of a section. **Flight order** assigns candidates in
flight order to slots in time order by dynamic programming (each used once, a repeated kind costing
0.15); **energy order** is a Hungarian assignment of slots to candidates, then adjacent repeated
kinds are swapped apart where it costs less than 0.15.

The search fills the cut with the **strong** candidates (quality at least `weakShare`, 0.35, of the
median) at pace multipliers 1, 0.8, 1.25 and 1.5, else with every candidate at 1, 0.8, 1.25, 0.65
and 1.5; the first that fills the whole cut wins, else the one filling most of it, and the cut
then ends with its last clip (the report says how much the footage filled). A weaker shot used to
fill the music says so in its reasons. **Variant** _n_ runs the assignment _n_ + 1 times, each
candidate chosen by an earlier run keeping `variantShare` (0.35) of its quality per run, and shifts
each window through the room its range leaves.

### Windows, transitions and fades

A clip plays its range at normal speed: all of it when it fits; else the end of a reveal (its
payoff), the start of an approach, the middle of other movements, inside the movement's ramps,
then shifted by the variant. Source lengths give exactly the slot's project frames, also at other
recording rates.

**auto** transitions: a cut where either side is in a peak section; a fade through black (2 beats,
12–30 frames, even) at a boundary in or near a silence or a sudden drop; a cross-dissolve (one
beat, 8–15 frames, at most a third of the shorter clip) between two slots of one quiet or release
section, or between two takes of one cluster or recording; otherwise a cut. **soft** dissolves
everywhere but at peaks; **cuts** keeps every cut. Dissolves use `keepCut`, so the perceived change
stays on the boundary; one whose footage would leave the recording or its kept ranges stays a cut,
with a note. The track opens with a fade up to the music's first beat (8 frames to 2 s) and closes
over its last bar (0.5–3 s), each at most half its clip. Music that lasts longer than the cut ends
with it, with the same closing fade.

### Placement

`replace` (the editor's copy): the project's video tracks and adjustments are removed and only the
followed music track is kept. `track` (the assistant): a new track above the others, which are
hidden, enabled adjustments turned off, other music tracks kept; a project with 8 video tracks is
refused with the reason.

### Grade

After the cut, on the in-memory project, by calling `estimate` as the assistant would, eight clips
at a time (a failing group is retried clip by clip and the failures noted):

- **none**: neutral clip grades.
- **auto**: `auto-adjust` with `applyAs: shots`, one clip grade per clip.
- **match** (default): with the brief's style, `match` of every clip to it; else Auto per clip,
  then `match` of every other clip to a **hero**: among the clips whose mean scene likeness to the
  others is at least `heroShare` (0.8) of the highest, the one with the best quality times one minus
  its exposure risk.

Grades stay static; Detail stays neutral.

## Report

`autoEditReportSchema`: the choices, duration and target, the track, the music (and whether auto
edit placed it), each clip (recording, source range, project frames, section, kind, quality and
reasons), transition counts, boundaries within a frame of a beat, downbeat or strong hit, alike
takes left out, steady ranges left out with their reason (the first 40 and their count), skipped
recordings, the grade (clips graded, hero or style, failures) and notes.

## Cost

Pictures take about 0.3 s per steady range, Auto about 1.6 s per clip and the match about 0.75 s per
clip on the still renderer's serial queue: about a minute and a half for a 34-clip cut of 45 steady
ranges. Planning itself takes well under a second.

## Limits

- **No sight.** Quality proxies miss subject, composition and the moment; a steady, well exposed
  shot of nothing can beat a shaky summit. The report, Try again and an assistant refining the cut
  cover it.
- **Alike terrain** can merge distinct subjects, or split one seen from two sides; the report shows
  the clusters it used.
- **Music analysis**: sections and downbeats are only as good as the analysis; with a weak meter
  the boundaries fall on beats.
- **Order** follows recording names; renamed files lose the flight order.
- **Tuning** comes from the owner's DJI flights; footage without telemetry only loses terms.
