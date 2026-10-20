# Multiple music tracks

Current contract for [#35](https://github.com/Plonk42/PasCap/issues/35), with music tracks that
hold several clips joined by transitions from [#203](https://github.com/Plonk42/PasCap/issues/203).
This specifies the required behaviour, not test evidence or release acceptance.
Usage belongs in [the user guide](../USER_GUIDE.md) and
[speed and audio](../SPEED_AND_AUDIO.md); resource/storage limits also belong in
[tracks and keyframes](../LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits) and
[UX hardening](../UX_HARDENING.md#issue-3-export-storage-and-recovery).

## Strict document, tracks and clips

- `schemaVersion` is exactly the current schema. Required `music: MusicLane[]` contains **0–8**
  independent music tracks; `[]` means no music. Omitted fields, `null`, a single
  object, unknown fields and duplicate IDs are invalid. There are no
  compatibility readers, null fallbacks or injected defaults.
- A music track works like a video track: it requires `id`, `gainDb` (**−60 to +12 dB**,
  for all its clips), `ripple`, `openingFade`, `closingFade`, **1–8** `clips` and their
  `transitions`. Each clip requires `id`, `mediaId`, `sourceIn`, `sourceOut`, `start`,
  `duration` and `loop`. Track and clip IDs are unique together across the project; a clip
  ID identifies the placement, not the registered recording, so several clips may use
  the same `mediaId` without sharing editable timing.
- Clips are in timeline order and exactly one transition joins each adjacent pair,
  `{ leftId, rightId, type, duration }`:
  - **Cut** (`cut`, duration 0): the next clip starts at or after the previous OUT; without
    Ripple a gap is allowed, never an overlap.
  - **Crossfade** (`crossfade`, duration ≥ 1): the next clip starts `duration` frames
    before the previous OUT; the left clip fades out and the right one fades in over
    those same frames, two linear fades, not an equal-power curve.
  - **Fade through silence** (`fade-through-silence`, duration ≥ 2): the clips touch; the
    left clip fades out over the larger half and the right one fades in over the other.
- With **Ripple** on, clips play one after another from the first clip's start; with it
  off, each clip keeps its own start, except that a crossfade or fade through silence
  places its right clip as above. No three clips overlap.
- Source IN/OUT, placement, fades and transitions are integer frames; OUT is exclusive.
  IN/start/fades are nonnegative; OUT/duration are positive. Frames and timeline
  OUT fit **0–2,147,483,647**. Reject overflow; never shorten or clamp a clip.
  Source OUT must exceed IN and fit the registered recording. Without looping, a clip's
  duration cannot exceed its selected source range; looping repeats only that range.
  The track's opening fade (first clip), closing fade (last clip) and each transition's
  fades must fit within every clip they touch.
- Required unique `media.videoIds` and `media.audioIds` remain project-bin
  membership, each limited to 10,000 IDs. Every music reference also counts as
  visible membership; importing does not place music implicitly.
- Video contracts do not change: 1–8 uniform tracks, required Ripple/transitions/
  opening/closing fades and sole video track `opacity` in 0–1. All fifteen nullable keyframe
  channels are `opacity`, twelve scalar colour fields (including
  `temperature`, `tint`, `vibrance`, `whites` and `blacks`), `hdr` and `localContrast`. Complete static/keyed Colour remains video track-owned;
  HSL/curves remain static. There is no clip colour/correction, clip opacity or
  second opacity channel. Clip-only constant/custom source-frame speed retains
  its ownership and retiming, plus a required boolean clip `reverse`. Projects also require video track-owned Transform
  base/per-setting project-frame keyframes;
  [spatial transforms](SPATIAL_TRANSFORMS.md) do not change music or video track Opacity.

Projects saved with an older supported schema are upgraded on load: a music track of the
previous schema becomes a track holding one clip that keeps its ID, with its gain and its
fades as the track's opening and closing fades, Ripple off and no transitions, so it plays
exactly as before. Projects and receipt snapshots older than the oldest supported schema
are rejected and preserved byte-for-byte, along with finished exports. Do not repair or
delete them automatically. Video-proxy and current `pcm16-48k-stereo-mono-unity-v3` PCM
cache formats and source guards are unchanged; the registries are version 2 (full-content
checksums).

## Duration, black tails and video fades

For placed video clips $c$ and music clips $m$, the exclusive project OUT is

$$
D = \max\left(\{0\} \cup \{c.\mathrm{end}\} \cup
\{m.\mathrm{start}+m.\mathrm{duration}\}\right).
$$

Use authoritative retimed clip ends, including hidden video tracks, and every
music clip's OUT. Music **can extend project duration**. Stored track keyframes
alone do not extend it. Seek/playback/export use this same duration; music
placement never follows video Ripple or video speed.

Each video track's closing fade stays inside its last clip and ends at that
clip's timeline OUT. It does not move to project OUT, stretch, or hold the last
image. Where no active video clip remains on an enabled track, composition is **opaque black** while
music continues; each music fade still ends at its own clip OUT. Music-only
preview is naturally black and uses the same output clock. Export requires at
least one retained video clip; this is not an audio-only export feature.

A music tail beyond video OUT requires the **composited exporter**, which fills
trailing black frames through project OUT. The static fast path still requires
one enabled, opaque, unanimated, zero-origin contiguous video track with Shadows/Highlights/HDR/Local contrast 0, exactly
neutral spatial bases and no spatial keyframes, covering
the entire project duration. No frozen-last-image or shortened-audio shortcut is
permitted.

## Selected music track and clip editing

**Audio → Music** uses a native **Music track** selector with its trash action
**Delete selected music track** (the track and its clips), and **Add music track**, which
lists ready files and creates a track holding one clip of the chosen recording, up to
the eight-track limit. Imports only populate the bin and prepare media; placement is
deliberate and separate. Project-level removal lives in Media.

The selected track's settings follow: **Gain dB**, **Ripple**, then the **Clip** selector
with **Delete selected music clip** (unavailable, with its reason, for a track's only
clip) and **+ Clip** (**Add music clip**), which appends a clip of a ready recording after
the last one, up to eight. The selected clip's **Recording**, beats, length and **Loop**
follow, then **Placement & fades**: the clip's source IN/OUT, timeline start and duration,
and the track's fade in and out. A track with several clips ends with its
**Transitions**: one Cut / Crossfade / Fade through silence selector per boundary, with
its duration. The timeline draws each boundary as a button that selects the clip before
it and focuses that transition. Dragging a ready file from Media → Music onto a music
track adds a clip at the drop frame (a Ripple track takes it at the nearest place in its
sequence); onto the empty music area it starts a track.

Selection is editor-only, with no save or Undo entry. Editing or removing a clip or track
never edits the other music tracks, video clips, track keyframes or bin membership.
Changing Recording targets only the selected clip, which keeps its start and length
(limited by the new recording unless it loops). Removal leaves the original/cache and
other placements intact; Undo restores it. Timeline waveform selection, placement and
edge trims target the clip's ID; a Ripple track re-sequences its later clips.

Each music track and clip retains independent field drafts. Tab/section hiding preserves
them; selection must not submit an old draft into a different music track. Numeric
Enter/blur commits once, Escape restores, and invalid drafts stay editable.
Gain uses a native slider plus an exact field: pointer movement is local, release
commits once; each keyboard adjustment is one edit. Timing gestures keep their
transient preview and captured geometry. Every accepted edit/add/remove or
completed gesture is **one Undo step**; unchanged, invalid or cancelled operations
change neither committed document nor history/autosave. Escape, pointer
cancellation, capture loss and window blur restore a gesture atomically.

## Mixing and sample placement

Every clip is one source. It plays with its track's gain and its own fades: the track's
opening fade on its first clip, closing fade on its last clip and, between clips, the fades
its transitions give it. Use PCM16 **48 kHz stereo** sources; mono is duplicated without
attenuation. Convert each source IN/OUT, start, duration and fade boundary independently to
integer samples at the rational project frame rate. For music clip $i$, local
elapsed samples $u$, duration $d_i$ and fade lengths $f_i^{\mathrm{in/out}}$, its
amplitude envelope is

$$
a_i(u)=10^{g_i/20}
\begin{cases}u/f_i^{\mathrm{in}},&0\le u<f_i^{\mathrm{in}}\\1,&\text{otherwise}\end{cases}
\begin{cases}(d_i-u)/f_i^{\mathrm{out}},&d_i-f_i^{\mathrm{out}}\le u<d_i\\1,&\text{otherwise}.\end{cases}
$$

A zero fade is absent, not division by zero. Outside a clip's placement it
contributes silence. Within placement, sample its selected source range, wrapping
only when Loop is enabled. Let $s_i$ be start samples and $x_{i,k}(u)$ the sampled
selected-range channel, zero outside $0\le u<d_i$. For each stereo channel $k$ and
project sample $n$,

$$
y_k(n)=\operatorname{clamp}_{[-1,1]}
\left(\sum_i a_i(n-s_i)x_{i,k}(n-s_i)\right).
$$

Sum **all** sources linearly after their individual gain/fades, then hard-clamp
**once**, after the complete sum. No per-source or intermediate clamp,
normalisation, ducking, effects, hidden gain compensation or source-video audio.
Opposite-polarity sources may cancel even when an individual contribution exceeds
unity. Native AAC is encoded only after the final clamp; it is not bitwise PCM
equivalence.

## Preview: one bounded mixed stream and output clock

One **AudioContext**, one **AudioWorklet** and one mixed stereo stream supply a
single audio-output timestamp clock/epoch. All music tracks align to project sample
positions on that clock; there is no per-track worklet, clock or restart at
loop/placement boundaries. Video starts after the device reaches the first real
rendered mixed sample's origin. Receipts independently retain the exact
**one-project-frame A/V bound**; this change does not relax decoder readiness,
drift checks, operation deadlines or cancellation.

Read/accumulate sources **serially** into one mixed block, apply their envelopes,
clamp the completed sum, and transfer it to the worklet. The aggregate bound,
independent of music track count and duration, is:

- **4 × 128 KiB** stereo Float32 queue/transfer blocks, **512 KiB total**, not four
  blocks per track.
- Bounded **64 KiB** source-range/short-loop read scratch, shared serially.
- One shared **128 KiB** conversion workspace and one **128 KiB** mixed-output
  workspace, not per-track copies.
- One unacknowledged consumption receipt and serial credit-controlled refill, run
  by one dedicated reader worker that exchanges credits/blocks directly with the
  worklet, independent of editor-thread rendering.

There are no full-file buffers, duration-sized silence buffers or per-track
queues. Short-loop scratch may be reused only within the current mixed block;
each refill still performs fresh identity-guarded range reads. Legitimate
placement silence is not an underrun. A missing active source/read/processor
failure is explicit; never silently omit a music clip or invent successful
silence. Pause, seek, edit, cancellation and disposal invalidate the entire mix
epoch, reads, queued blocks and late receipts together.

## Native export: serial floating accumulation

Capture the project, every referenced registered audio original and each
music clip's plan before queue admission. Verify source identity before/
after selected decoding and before publication. Keep one serial heavy worker.

1. Decode **one original at a time** to the exact selected **48 kHz stereo s16
   PCM** range; never store the full original or every loop repetition.
2. Stream that selected range/loop with its placement silence, gain and fades.
   Pairwise-sum it with the previous full-project stereo **Float64 accumulator**
   into the next Float64 accumulator. No normalisation or intermediate clamp;
   values outside −1–1 survive subsequent cancellation.
3. Verify exact sample counts and delete consumed selected PCM/old accumulator
   before processing the next music clip. At most **two intermediate audio inputs**,
   **one native audio child per pass** and **three audio scratch files** coexist:
   selected source, old accumulator, new accumulator.
4. Feed one final mixed input to AAC, hard-clamping once after all sources.
   Silence/padding and exact output length follow **full project duration**, not
   video-only duration. Failed/cancelled work cleans only owned scratch/partials;
   originals, saved projects and successful exports/receipts remain untouched.

Audio disk planning is **maximum selected s16 PCM size + two full-project Float64
stereo timelines**, not the sum of all selected files. If $S$ is the project
sample count and $L_i$ a selected source sample count, the audio allowance is
$4\max_i L_i+2\times16S$ bytes when music exists, zero without music, excluding
container overhead. Add the existing video/encoded allowance, 25% margin and
16 MiB start reserve. This is duration-dependent advisory planning, not reserved
space, a compressed-size prediction or a fixed-GB promise.

Video bounds remain unchanged: one original video decoder, two intermediate
readers, one encoder and at most three native video children per serial pass;
two retained clip files and three timeline representations; four raw buffers at
**22 bytes/pixel (182,476,800 bytes UHD)** and two reusable **65³ Float32 LUTs
(6,591,000 bytes)**. Audio storage/workspaces are additional, not substitutions
for those video budgets.

## Receipts, preservation and acceptance

Export receipt format remains **version 1**, with a strict **current-schema project
snapshot**. Required `musicSources` is an array of captured unique registered
audio assets; required `settings.audio` is an array of plans, one per music clip,
carrying its `id`/`mediaId`, its track's gain and its own timing/fades/loop sample
positions. Both are
empty arrays without music, never singular/null/default-filled values. Several
plans may refer to one captured original. The existing plan name `videoSamples`
denotes the **full project** sample count, including music tails, not video-only
OUT. A receipt whose snapshot an older supported schema saved is upgraded in memory
like a project; its plans still match, since each upgraded clip keeps its ID. Reject
older snapshots or invalid arrays clearly and preserve their receipts and finished MP4s.

Pending acceptance includes strict schema/receipt rejection and preservation;
independent selection/drafts/Undo and cancellation; repeated-source music tracks;
overlap/cancellation and final-only clipping; placement silence, loops and sample
counts; one output epoch and unchanged A/V bound; video closing fade followed by
black through a music tail; music-only black preview and video-required export;
frame-range overflow; immutable queued snapshots, serial native resource peaks
and duration-dependent preflight/cleanup. Browser UI acceptance additionally
requires live integrated-browser interaction and rendered desktop/compact
screenshots. No results are claimed here.

Sequential work on milestone issues is not milestone closure or release approval.
Real-media preparation/rendering, hardware/long-run qualification, releases and
milestone closure still require explicit owner approval.
